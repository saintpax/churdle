(function () {
  "use strict";

  // ---------- Constants ----------
  var COLORS = {
    surface: "#1f1f1f",
    line: "#e8e8e8",
    lineDim: "#8a8a8a",
    glow: "rgba(255,255,255,0.55)",
  };

  var PUCK_RADIUS = 14;
  var LAUNCH_MIN_SPEED = 250; // px/s
  var LAUNCH_MAX_SPEED = 1500; // px/s
  var FRICTION_COEFF = 0.5; // velocity fraction remaining after 1 full second
  var WALL_RESTITUTION = 0.82;
  var PEG_RESTITUTION = 0.88;
  var REST_VELOCITY_EPS = 40; // px/s, below this the puck is considered stopped
  var FLIGHT_TIMEOUT = 2.8; // seconds, hard cap so a missed shot never drags on
  var SCORE_TRANSITION = 0.55; // seconds
  var MISS_TRANSITION = 0.45; // seconds
  var FIXED_DT = 1 / 120;
  var TABLE_MAX_WIDTH = 480;

  var LEVELS = [
    { id: 1, goalWidth: 140, goalSpeed: 0, goalAmplitude: 0, obstacles: [], attempts: 5 },
    { id: 2, goalWidth: 120, goalSpeed: 0, goalAmplitude: 0, obstacles: [], attempts: 5 },
    { id: 3, goalWidth: 100, goalSpeed: 40, goalAmplitude: 60, obstacles: [], attempts: 4 },
    {
      id: 4,
      goalWidth: 90,
      goalSpeed: 55,
      goalAmplitude: 80,
      obstacles: [
        { x: 0.3, y: 0.5, radius: 10 },
        { x: 0.7, y: 0.5, radius: 10 },
      ],
      attempts: 4,
    },
    {
      id: 5,
      goalWidth: 70,
      goalSpeed: 70,
      goalAmplitude: 90,
      obstacles: [
        { x: 0.25, y: 0.45, radius: 10 },
        { x: 0.75, y: 0.45, radius: 10 },
        { x: 0.5, y: 0.65, radius: 9 },
      ],
      attempts: 3,
    },
  ];

  function seededRandom(seed) {
    var t = (seed + 0x6d2b79f5) | 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function generatePegs(count, levelId) {
    var pegs = [];
    for (var i = 0; i < count; i++) {
      var r1 = seededRandom(levelId * 97 + i * 13);
      var r2 = seededRandom(levelId * 131 + i * 17 + 1);
      pegs.push({ x: 0.2 + r1 * 0.6, y: 0.35 + r2 * 0.35, radius: 9 });
    }
    return pegs;
  }

  function getLevelConfig(n) {
    if (n <= LEVELS.length) return LEVELS[n - 1];
    var extra = n - LEVELS.length;
    var goalWidth = Math.max(50, 70 - extra * 3);
    var goalAmplitude = Math.min(120, 90 + extra * 4);
    var goalSpeed = Math.min(100, 70 + extra * 3);
    var pegCount = Math.min(5, 3 + Math.floor(extra / 2));
    var attempts = Math.max(2, 3 - Math.floor(extra / 5));
    return {
      id: n,
      goalWidth: goalWidth,
      goalSpeed: goalSpeed,
      goalAmplitude: goalAmplitude,
      obstacles: generatePegs(pegCount, n),
      attempts: attempts,
    };
  }

  // ---------- Setup ----------
  var canvas = document.getElementById("table");
  var ctx = canvas.getContext("2d");
  var hudLevel = document.getElementById("hud-level");
  var hudStreak = document.getElementById("hud-streak");
  var hudAttempts = document.getElementById("hud-attempts");
  var overlayStart = document.getElementById("overlay-start");
  var overlayFailed = document.getElementById("overlay-failed");
  var failedText = document.getElementById("failed-text");

  var W = 0,
    H = 0;
  var tableRect = { left: 0, right: 0, top: 0, bottom: 0 };
  var nowMs = 0;

  var goal = { centerX: 0, x: 0, amplitude: 0, speed: 0, phase: 0 };
  var puck = { x: 0, y: 0, vx: 0, vy: 0, radius: PUCK_RADIUS, moving: false, pulse: 1 };

  var state = {
    screen: "start", // start | aiming | flight | scored | missed | levelFailed
    level: 1,
    attemptsLeft: 0,
    streak: 0,
    best: 0,
    config: null,
    obstacles: [],
    transitionTimer: 0,
    flightTimer: 0,
  };

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  // ---------- Sizing ----------
  function resize() {
    var dpr = window.devicePixelRatio || 1;
    var cssWidth = Math.min(window.innerWidth, TABLE_MAX_WIDTH);
    var cssHeight = window.innerHeight;

    canvas.style.width = cssWidth + "px";
    canvas.style.height = cssHeight + "px";
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    W = cssWidth;
    H = cssHeight;

    tableRect.left = 24;
    tableRect.right = W - 24;
    tableRect.top = 84;
    tableRect.bottom = H - 40;

    goal.centerX = (tableRect.left + tableRect.right) / 2;
    if (!goal.x) goal.x = goal.centerX;

    if (state.config) {
      setupObstaclesForLevel(state.config);
      if (!puck.moving) resetPuckToLaunch();
    } else {
      puck.x = goal.centerX;
      puck.y = tableRect.bottom - puck.radius - 16;
    }
  }

  // ---------- Level / state machine ----------
  function setupGoalForLevel(cfg) {
    goal.amplitude = cfg.goalAmplitude;
    goal.speed = cfg.goalSpeed;
    goal.phase = 0;
    goal.x = goal.centerX;
  }

  function setupObstaclesForLevel(cfg) {
    var tw = tableRect.right - tableRect.left;
    var th = tableRect.bottom - tableRect.top;
    state.obstacles = cfg.obstacles.map(function (o) {
      return { x: tableRect.left + o.x * tw, y: tableRect.top + o.y * th, radius: o.radius };
    });
  }

  function resetPuckToLaunch() {
    puck.x = goal.centerX;
    puck.y = tableRect.bottom - puck.radius - 16;
    puck.vx = 0;
    puck.vy = 0;
    puck.moving = false;
    puck.pulse = 1;
  }

  function startLevel(n, isRetry) {
    var cfg = getLevelConfig(n);
    state.level = n;
    state.config = cfg;
    state.attemptsLeft = cfg.attempts;
    setupGoalForLevel(cfg);
    setupObstaclesForLevel(cfg);
    resetPuckToLaunch();
    state.screen = "aiming";
    updateHUD();
    if (!isRetry) pulseHUDLevel();
  }

  function onScore() {
    state.streak++;
    if (state.streak > state.best) {
      state.best = state.streak;
      try {
        localStorage.setItem("flick_best", String(state.best));
      } catch (e) {}
    }
    state.screen = "scored";
    state.transitionTimer = SCORE_TRANSITION;
    updateHUD();
  }

  function onMiss() {
    state.attemptsLeft--;
    state.streak = 0;
    updateHUD();
    if (state.attemptsLeft > 0) {
      state.screen = "missed";
      state.transitionTimer = MISS_TRANSITION;
    } else {
      state.screen = "levelFailed";
      showFailedOverlay();
    }
  }

  function showFailedOverlay() {
    failedText.textContent = "Missed — Level " + state.level;
    overlayFailed.classList.remove("hidden");
  }

  function hideOverlay(el) {
    el.classList.add("hidden");
  }

  // ---------- HUD ----------
  function updateHUD() {
    hudLevel.textContent = "Level " + state.level;
    hudStreak.textContent = "Streak " + state.streak + " · Best " + state.best;
    if (state.config && state.config.attempts <= 4) {
      var dots = "";
      for (var i = 0; i < state.attemptsLeft; i++) dots += "●";
      for (var j = 0; j < state.config.attempts - state.attemptsLeft; j++) dots += "○";
      hudAttempts.textContent = dots;
      hudAttempts.classList.remove("hidden");
    } else {
      hudAttempts.classList.add("hidden");
    }
  }

  function pulseHUDLevel() {
    hudLevel.classList.add("pulse");
    setTimeout(function () {
      hudLevel.classList.remove("pulse");
    }, 250);
  }

  // ---------- Physics ----------
  function updatePhysics(dt) {
    var cfg = state.config;

    if (cfg && goal.amplitude > 0 && goal.speed > 0) {
      var omega = goal.speed / goal.amplitude;
      goal.phase += omega * dt;
      var maxAmp = Math.max(0, (tableRect.right - tableRect.left) / 2 - cfg.goalWidth / 2 - 8);
      var amp = Math.min(goal.amplitude, maxAmp);
      goal.x = clamp(
        goal.centerX + Math.sin(goal.phase) * amp,
        tableRect.left + cfg.goalWidth / 2 + 4,
        tableRect.right - cfg.goalWidth / 2 - 4
      );
    }

    puck.pulse += (1 - puck.pulse) * 0.25;

    if (state.screen === "scored") {
      state.transitionTimer -= dt;
      if (state.transitionTimer <= 0) startLevel(state.level + 1, false);
      return;
    }

    if (state.screen === "missed") {
      state.transitionTimer -= dt;
      if (state.transitionTimer <= 0) {
        resetPuckToLaunch();
        state.screen = "aiming";
      }
      return;
    }

    if (state.screen !== "flight" || !puck.moving) return;

    state.flightTimer += dt;

    puck.x += puck.vx * dt;
    puck.y += puck.vy * dt;

    var frictionFactor = Math.pow(FRICTION_COEFF, dt);
    puck.vx *= frictionFactor;
    puck.vy *= frictionFactor;

    if (puck.x - puck.radius < tableRect.left) {
      puck.x = tableRect.left + puck.radius;
      puck.vx = -puck.vx * WALL_RESTITUTION;
      puck.pulse = 1.3;
    } else if (puck.x + puck.radius > tableRect.right) {
      puck.x = tableRect.right - puck.radius;
      puck.vx = -puck.vx * WALL_RESTITUTION;
      puck.pulse = 1.3;
    }

    for (var i = 0; i < state.obstacles.length; i++) {
      var peg = state.obstacles[i];
      var dx = puck.x - peg.x,
        dy = puck.y - peg.y;
      var dist = Math.hypot(dx, dy);
      var minDist = puck.radius + peg.radius;
      if (dist < minDist && dist > 0) {
        var nx = dx / dist,
          ny = dy / dist;
        var overlap = minDist - dist;
        puck.x += nx * overlap;
        puck.y += ny * overlap;
        var vDotN = puck.vx * nx + puck.vy * ny;
        puck.vx = (puck.vx - 2 * vDotN * nx) * PEG_RESTITUTION;
        puck.vy = (puck.vy - 2 * vDotN * ny) * PEG_RESTITUTION;
        puck.pulse = 1.3;
      }
    }

    if (puck.y - puck.radius <= tableRect.top) {
      var goalLeft = goal.x - cfg.goalWidth / 2;
      var goalRight = goal.x + cfg.goalWidth / 2;
      if (puck.x >= goalLeft && puck.x <= goalRight) {
        puck.moving = false;
        onScore();
        return;
      } else {
        puck.y = tableRect.top + puck.radius;
        puck.vy = -puck.vy * WALL_RESTITUTION;
        puck.pulse = 1.3;
      }
    }

    var speed = Math.hypot(puck.vx, puck.vy);
    if (speed < REST_VELOCITY_EPS || state.flightTimer >= FLIGHT_TIMEOUT) {
      puck.vx = 0;
      puck.vy = 0;
      puck.moving = false;
      onMiss();
    }
  }

  // ---------- Rendering ----------
  function drawTable() {
    var left = tableRect.left,
      right = tableRect.right,
      top = tableRect.top,
      bottom = tableRect.bottom;

    ctx.fillStyle = COLORS.surface;
    ctx.fillRect(left, top, right - left, bottom - top);

    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = COLORS.line;

    // left + bottom + right walls as one continuous stroke
    ctx.beginPath();
    ctx.moveTo(left, top);
    ctx.lineTo(left, bottom);
    ctx.lineTo(right, bottom);
    ctx.lineTo(right, top);
    ctx.stroke();

    // top wall, split around the goal gap
    var cfg = state.config;
    var goalWidth = cfg ? cfg.goalWidth : 0;
    var goalLeft = goal.x - goalWidth / 2;
    var goalRight = goal.x + goalWidth / 2;

    ctx.beginPath();
    ctx.moveTo(left, top);
    ctx.lineTo(Math.max(left, goalLeft), top);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(Math.min(right, goalRight), top);
    ctx.lineTo(right, top);
    ctx.stroke();

    if (cfg) drawGoalBracket(goalLeft, goalRight, top);
  }

  function drawGoalBracket(glx, grx, topY) {
    ctx.save();
    if (state.screen === "scored") {
      var glow = clamp(state.transitionTimer / SCORE_TRANSITION, 0, 1);
      ctx.shadowBlur = 20 * glow;
      ctx.shadowColor = COLORS.glow;
    }
    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(glx, topY);
    ctx.lineTo(glx, topY - 12);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(grx, topY);
    ctx.lineTo(grx, topY - 12);
    ctx.stroke();
    ctx.restore();
  }

  function drawObstacles() {
    ctx.fillStyle = COLORS.lineDim;
    for (var i = 0; i < state.obstacles.length; i++) {
      var peg = state.obstacles[i];
      ctx.beginPath();
      ctx.arc(peg.x, peg.y, peg.radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawPuck() {
    var x = puck.x,
      y = puck.y,
      scale = puck.pulse,
      alpha = 1;

    if (state.screen === "scored") {
      var progress = 1 - clamp(state.transitionTimer / SCORE_TRANSITION, 0, 1);
      scale *= 1 - progress * 0.7;
      alpha = 1 - progress;
      y -= progress * 18;
    } else if (state.screen === "aiming") {
      scale *= 1 + Math.sin(nowMs / 900) * 0.035;
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = COLORS.line;
    ctx.beginPath();
    ctx.arc(x, y, puck.radius * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function render() {
    ctx.clearRect(0, 0, W, H);
    drawTable();
    drawObstacles();
    drawPuck();
  }

  // ---------- Input ----------
  var gesturePoints = [];
  var activePointerId = null;

  function onPointerDown(e) {
    if (state.screen !== "aiming" || puck.moving) return;
    activePointerId = e.pointerId;
    gesturePoints = [{ x: e.clientX, y: e.clientY, t: performance.now() }];
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch (err) {}
  }

  function onPointerMove(e) {
    if (e.pointerId !== activePointerId) return;
    var now = performance.now();
    gesturePoints.push({ x: e.clientX, y: e.clientY, t: now });
    while (gesturePoints.length > 2 && now - gesturePoints[0].t > 150) gesturePoints.shift();
  }

  function onPointerUp(e) {
    if (e.pointerId !== activePointerId) return;
    finishGesture();
  }

  function finishGesture() {
    activePointerId = null;
    var pts = gesturePoints;
    gesturePoints = [];
    if (pts.length < 2) return;

    var now = pts[pts.length - 1].t;
    var recent = pts.filter(function (p) {
      return now - p.t <= 100;
    });
    var sample = recent.length >= 2 ? recent : pts.slice(-2);
    var first = sample[0],
      last = sample[sample.length - 1];
    var dtSec = (last.t - first.t) / 1000;
    if (dtSec <= 0) return;

    var dx = last.x - first.x;
    var dy = last.y - first.y;
    var rawVy = dy / dtSec;
    if (rawVy >= -50) return; // require a meaningful upward swipe

    var rawVx = dx / dtSec;
    var speed = Math.hypot(rawVx, rawVy);
    if (speed < LAUNCH_MIN_SPEED) return;

    var scale = Math.min(speed, LAUNCH_MAX_SPEED) / speed;
    puck.vx = rawVx * scale;
    puck.vy = rawVy * scale;
    puck.moving = true;
    state.flightTimer = 0;
    state.screen = "flight";
  }

  // ---------- Boot ----------
  function loop(now) {
    if (!loop.lastTime) loop.lastTime = now;
    var frameTime = (now - loop.lastTime) / 1000;
    loop.lastTime = now;
    if (frameTime > 0.25) frameTime = 0.25;

    loop.accumulator = (loop.accumulator || 0) + frameTime;
    while (loop.accumulator >= FIXED_DT) {
      updatePhysics(FIXED_DT);
      loop.accumulator -= FIXED_DT;
    }

    nowMs = now;
    render();
    requestAnimationFrame(loop);
  }

  function init() {
    resize();
    window.addEventListener("resize", resize);
    window.addEventListener("orientationchange", resize);

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);

    function beginFromStart() {
      if (state.screen !== "start") return;
      hideOverlay(overlayStart);
      startLevel(1, false);
    }

    function retryFromFailed() {
      if (state.screen !== "levelFailed") return;
      hideOverlay(overlayFailed);
      startLevel(state.level, true);
    }

    overlayStart.addEventListener("click", beginFromStart);
    overlayStart.addEventListener("pointerup", beginFromStart);
    overlayFailed.addEventListener("click", retryFromFailed);
    overlayFailed.addEventListener("pointerup", retryFromFailed);

    try {
      state.best = Number(localStorage.getItem("flick_best") || 0);
    } catch (e) {}
    updateHUD();

    if (new URLSearchParams(location.search).get("debug") === "1") {
      window.__debugSetLevel = function (n) {
        hideOverlay(overlayStart);
        hideOverlay(overlayFailed);
        startLevel(n, false);
      };
    }

    requestAnimationFrame(loop);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
