'use strict';

const byId = id => document.getElementById(id);
const text = (id, value) => {
  const el = byId(id);
  if (el) el.textContent = value;
};
const { formatTokenCount, formatExactTokenCount } = window.TokemperatureTokenFormat;
const { normalizeCostCurrency, formatEstimatedCost } = window.TokemperatureCostFormat;
const { computeThermalState, estimateDayTemperature, tierForTemperature } = window.TokemperatureThermal;

const COST_CURRENCY_KEY = 'tokemperature.costCurrency';
const PALETTE_KEY = 'tokemperature.palette';
const LAST_NOTIFIED_KEY = 'tokemperature.lastNotified';

const percent = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1, minimumFractionDigits: 1 });
const periodLabels = { today: '今日', month: '本月', allTime: '累计' };
const dimensionLabels = { tools: '工具', models: '模型', projects: '项目' };
const toolLabels = window.TokenMonitorClientCatalog.CLIENT_LABELS;
const components = [
  ['inputTokens', '未缓存输入'], ['outputTokens', '输出'], ['cacheReadTokens', '缓存读取'],
  ['cacheWriteTokens', '缓存写入'], ['unclassifiedTokens', '未分类']
];
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function storedValue(key, normalize) {
  try { return normalize(localStorage.getItem(key)); }
  catch { return normalize(null); }
}

const normalizePalette = value => (value === 'calm' ? 'calm' : 'thermal');

const state = {
  selection: 'today',
  dimension: 'tools',
  currency: storedValue(COST_CURRENCY_KEY, normalizeCostCurrency),
  palette: storedValue(PALETTE_KEY, normalizePalette),
  days: 30,
  summary: null,
  history: null,
  thermostat: { revision: 0, mode: 'auto', value: 0, notify: false },
  thermal: null,
  offline: false,
  hover: null,
  selectedDate: null,
  dayDistribution: null,
  dayError: false,
  preview: {
    active: false,
    temp: 72,
    panelOpen: false
  }
};

const trendSource = byId('trend-source');
const costCurrency = byId('cost-currency');
const canvas = byId('chart');
const sparkCanvas = byId('burn-sparkline');
const stack = byId('stack');
const heatmapGrid = byId('heatmap-grid');
const rankDate = byId('rank-date');

let chartGeometry;
let stream;
let currentRequest;
let dayRequest;
let heatmapSignature;
let lastSeenTodayTokens = null;
let countAnimationFrame = 0;
let deltaHideTimer;
let lastFaviconKey = '';
let favCanvas;
let crucibleMounted = false;
let lastCruciblePayload = null;
let activeCacheRatio = 0;

function node(tag, content, css) {
  const element = document.createElement(tag);
  if (content !== undefined) element.textContent = content;
  if (css) element.className = css;
  return element;
}

function labelForTool(id) {
  return toolLabels[id] ?? id;
}

function showTokenCount(element, value, suffix = '') {
  const display = formatTokenCount(value);
  const exact = formatExactTokenCount(value);
  element.textContent = `${display}${suffix}`;
  if (display !== exact) element.title = `${exact}${suffix || ' Token'}`;
  else element.removeAttribute('title');
}

function animateTokenIncrease(element, fromValue, toValue) {
  cancelAnimationFrame(countAnimationFrame);
  if (reducedMotion.matches || !Number.isFinite(fromValue) || !Number.isFinite(toValue) || toValue <= fromValue) {
    showTokenCount(element, toValue);
    return;
  }
  const start = performance.now();
  const duration = 450;
  const step = now => {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = Math.round(fromValue + (toValue - fromValue) * eased);
    element.textContent = formatTokenCount(current);
    if (progress < 1) countAnimationFrame = requestAnimationFrame(step);
    else showTokenCount(element, toValue);
  };
  countAnimationFrame = requestAnimationFrame(step);
}

function priceOf(row, count = row.tokens) {
  if (count > 0 && row.unpricedTokens >= count) return '—';
  return formatEstimatedCost(row.costUsd, state.currency, state.summary?.cnyQuote?.rate);
}

function applyPalette(next) {
  state.palette = normalizePalette(next);
  document.documentElement.dataset.palette = state.palette;
  const toggle = byId('palette-toggle');
  const isCalm = state.palette === 'calm';
  toggle.setAttribute('aria-pressed', String(isCalm));
  toggle.textContent = isCalm ? '护眼静谧' : '热成像';
}

function updateFavicon(thermal) {
  const key = `${thermal.displayTemp ?? 'none'}:${thermal.tier.id}:${thermal.burning ? 1 : 0}:${state.palette}`;
  if (key === lastFaviconKey) return;
  lastFaviconKey = key;
  if (!favCanvas) {
    favCanvas = document.createElement('canvas');
    favCanvas.width = 32;
    favCanvas.height = 32;
  }
  const ctx = favCanvas.getContext('2d');
  ctx.clearRect(0, 0, 32, 32);
  ctx.fillStyle = state.palette === 'calm' ? '#0f1411' : '#120d0c';
  ctx.beginPath();
  ctx.roundRect(1, 1, 30, 30, 8);
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = thermal.tier.color;
  ctx.stroke();

  if (thermal.displayTemp !== null) {
    ctx.fillStyle = thermal.tier.color;
    ctx.font = 'bold 13px Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(Math.min(999, thermal.displayTemp)), 16, 17);
  } else {
    ctx.fillStyle = thermal.tier.color;
    ctx.beginPath();
    ctx.arc(16, 16, 5, 0, Math.PI * 2);
    ctx.fill();
  }
  try {
    byId('favicon').href = favCanvas.toDataURL('image/png');
  } catch { /* Ignore canvas export errors in restricted contexts. */ }
}

function updateTabAndFavicon(thermal) {
  if (thermal.displayTemp !== null) {
    const flame = thermal.burning ? '🔥 ' : '';
    document.title = `${flame}${thermal.displayTemp}°C ${thermal.tier.short} · Tokemperature`;
  } else {
    document.title = 'Tokemperature · 算力坩埚';
  }
  updateFavicon(thermal);
}

function formatTargetSummary(thermal) {
  const pct = `已达 ${thermal.progressPercent}%`;
  if (thermal.targetKind === 'tokens') return `自定沸点：${formatTokenCount(thermal.targetValue)} Token（${pct}）`;
  if (thermal.targetKind === 'cny') return `自定沸点：¥${thermal.targetValue.toFixed(2)}（${pct}）`;
  if (thermal.targetKind === 'usd') return `自定沸点：$${thermal.targetValue.toFixed(2)}（${pct}）`;
  return `智能沸点基准：${formatTokenCount(thermal.targetValue)} Token（${pct}）`;
}

function maybeNotifyThermostat(thermal) {
  if (state.preview.active || !state.thermostat?.notify) return;
  const level = thermal.alert?.level;
  if (level !== 'warning' && level !== 'overheat') return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const todayKey = state.history?.end || new Date().toISOString().slice(0, 10);
  const stamp = `${todayKey}:${level}`;
  try {
    if (localStorage.getItem(LAST_NOTIFIED_KEY) === stamp) return;
    localStorage.setItem(LAST_NOTIFIED_KEY, stamp);
  } catch { /* Continue without persistence if storage is blocked. */ }
  const title = level === 'overheat' ? 'Tokemperature · 今日算力已达沸点' : 'Tokemperature · 接近今日温控阈值';
  const body = `当前炉温 ${thermal.displayTemp}°C（${thermal.tier.label}），已达设定阈值的 ${thermal.progressPercent}%。`;
  try { new Notification(title, { body }); } catch { /* Ignore Notification failures. */ }
}

function renderThermostatBanner(thermal) {
  const banner = byId('thermostat-banner');
  const level = thermal.alert?.level;
  if (level === 'overheat') {
    banner.dataset.level = 'overheat';
    banner.textContent = `温控提醒：今日消耗已达设定沸点（${thermal.progressPercent}% · ${thermal.displayTemp}°C），注意控制预算节奏。`;
    banner.hidden = false;
  } else if (level === 'warning') {
    banner.dataset.level = 'warning';
    banner.textContent = `温控预警：今日消耗已达设定阈值的 ${thermal.progressPercent}%（${thermal.displayTemp}°C），即将到达沸点。`;
    banner.hidden = false;
  } else if (level === 'boiling') {
    banner.dataset.level = 'boiling';
    banner.textContent = `算力沸腾：今日热度已突破日常基准线（${thermal.displayTemp}°C · ${thermal.tier.label}）！`;
    banner.hidden = false;
  } else {
    banner.hidden = true;
    banner.textContent = '';
    delete banner.dataset.level;
  }
}

function drawSparkline(points, tier) {
  const { width, height } = sparkCanvas.getBoundingClientRect();
  if (!width || !height) return;
  const dpr = window.devicePixelRatio || 1;
  sparkCanvas.width = Math.round(width * dpr);
  sparkCanvas.height = Math.round(height * dpr);
  const ctx = sparkCanvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const values = Array.isArray(points) && points.length ? points : Array(12).fill(0);
  const peak = Math.max(0, ...values);
  byId('sparkline-empty').hidden = peak > 0;
  if (peak <= 0) return;

  const padX = 6;
  const padY = 7;
  const usableW = width - padX * 2;
  const usableH = height - padY * 2;
  const step = usableW / Math.max(1, values.length - 1);
  const coords = values.map((val, idx) => ({
    x: padX + idx * step,
    y: height - padY - (val / peak) * usableH
  }));

  const isBoiling = tier.id === 'boiling' && state.palette !== 'calm';
  const lineColor = isBoiling ? '#7ce2ff' : tier.color;
  const areaGrad = ctx.createLinearGradient(0, padY, 0, height);
  if (state.palette === 'calm') {
    areaGrad.addColorStop(0, 'rgba(166, 214, 128, 0.35)');
    areaGrad.addColorStop(1, 'rgba(166, 214, 128, 0.02)');
  } else if (isBoiling) {
    areaGrad.addColorStop(0, 'rgba(124, 226, 255, 0.45)');
    areaGrad.addColorStop(1, 'rgba(255, 110, 40, 0.04)');
  } else {
    areaGrad.addColorStop(0, 'rgba(255, 126, 54, 0.45)');
    areaGrad.addColorStop(1, 'rgba(255, 78, 46, 0.02)');
  }

  ctx.beginPath();
  ctx.moveTo(coords[0].x, height - 2);
  for (const pt of coords) ctx.lineTo(pt.x, pt.y);
  ctx.lineTo(coords.at(-1).x, height - 2);
  ctx.closePath();
  ctx.fillStyle = areaGrad;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(coords[0].x, coords[0].y);
  for (let i = 1; i < coords.length; i += 1) ctx.lineTo(coords[i].x, coords[i].y);
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();

  const last = coords.at(-1);
  ctx.fillStyle = isBoiling ? '#e6fbff' : '#fff1c9';
  ctx.beginPath();
  ctx.arc(last.x, last.y, 3, 0, Math.PI * 2);
  ctx.fill();
}

function setHighlightedConduit(index) {
  window.TokemperatureCrucible?.highlightConduit(index);
  const legend = byId('conduit-legend');
  if (!legend) return;
  for (const chip of legend.querySelectorAll('.conduit-chip')) {
    chip.classList.toggle('is-highlighted', Number(chip.dataset.conduit) === index);
  }
}

function renderConduitLegend(burners) {
  const legend = byId('conduit-legend');
  if (!legend) return;
  for (const chip of legend.querySelectorAll('.conduit-chip')) {
    const idx = Number(chip.dataset.conduit);
    const burner = burners[idx];
    const span = chip.querySelector('span');
    if (!burner) {
      chip.dataset.state = 'idle';
      chip.title = `燃料导管 C${idx + 1}：空闲待命`;
      if (span) span.textContent = `C${idx + 1} 空闲`;
    } else {
      chip.dataset.state = burner.state;
      const toolName = labelForTool(burner.client);
      chip.title = `燃料导管 C${idx + 1}：${toolName} · ${burner.project || '本地会话'}`;
      if (span) span.textContent = `C${idx + 1} ${toolName}`;
    }
  }
}

function renderBurners(live) {
  const strip = byId('burners-strip');
  const burners = live?.burners || [];
  text('burners-count', burners.length ? `${live?.runningCount || 0} 运行 · ${burners.length} 路并发` : '0 路活跃');
  renderConduitLegend(burners);
  if (!burners.length) {
    const empty = node('span', state.summary?.periods ? '暂无正在运行的会话，采集到活动后将实时亮起并驱动导管' : '等待采集会话活动', 'burners-idle');
    strip.replaceChildren(empty);
    return;
  }
  strip.replaceChildren(...burners.map((burner, idx) => {
    const pill = node('span', undefined, 'burner-pill');
    pill.dataset.state = burner.state;
    const conduitIdx = idx < 4 ? idx : -1;
    if (conduitIdx >= 0) {
      pill.dataset.conduitIdx = String(conduitIdx);
      pill.tabIndex = 0;
    }

    const left = node('span', undefined, 'burner-left');
    const dot = node('i', undefined, 'burner-dot');
    dot.setAttribute('aria-hidden', 'true');
    left.append(dot);
    if (conduitIdx >= 0) {
      left.append(node('span', `C${conduitIdx + 1}`, 'burner-conduit-tag'));
    }
    const tool = node('span', labelForTool(burner.client), 'burner-tool');
    const project = node('span', burner.project || '本地会话', 'burner-project');
    left.append(tool, node('span', '·', 'burner-meta'), project);
    if (burner.model) {
      left.append(node('span', burner.model, 'burner-meta'));
    }

    pill.append(left);
    if (Number.isFinite(burner.contextPercentUsed)) {
      const ctx = node('span', `上下文 ${burner.contextPercentUsed}%`, 'burner-ctx');
      if (burner.contextTone) ctx.dataset.tone = burner.contextTone;
      pill.append(ctx);
    }
    pill.title = burner.state === 'waiting'
      ? `等待用户输入${conduitIdx >= 0 ? `（悬停高亮导管 C${conduitIdx + 1}）` : ''}`
      : `${labelForTool(burner.client)} 正在持续输出${conduitIdx >= 0 ? `（悬停高亮导管 C${conduitIdx + 1}）` : ''}`;
    return pill;
  }));
}

function renderRecords(records) {
  const streakEl = byId('record-streak');
  const streakNoteEl = byId('record-streak-note');
  if (records.hotStreakDays > 0) {
    streakEl.textContent = `${records.hotStreakDays} 天`;
    streakNoteEl.textContent = '连续 70% 热浪';
  } else if (records.activeStreakDays > 0) {
    streakEl.textContent = `活跃 ${records.activeStreakDays} 天`;
    streakNoteEl.textContent = '暂未连成高热';
  } else {
    streakEl.textContent = '0 天';
    streakNoteEl.textContent = '日均 70% 热线';
  }

  const peakBtn = byId('record-peak-btn');
  const peakEl = byId('record-peak');
  const peakNoteEl = byId('record-peak-note');
  if (records.peakDay) {
    const est = estimateDayTemperature(records.peakDay.tokens, records);
    peakBtn.disabled = false;
    peakBtn.dataset.date = records.peakDay.date;
    peakEl.textContent = `${records.peakDay.date.slice(5)} · ${formatTokenCount(records.peakDay.tokens)}`;
    peakNoteEl.textContent = `约 ${Math.round(est)}°C · 点选定位`;
  } else {
    peakBtn.disabled = true;
    delete peakBtn.dataset.date;
    peakEl.textContent = '—';
    peakNoteEl.textContent = '暂无峰值记录';
  }

  const trendEl = byId('record-week-trend');
  const trendNoteEl = byId('record-week-note');
  trendEl.className = '';
  if (records.weekTrendRatio !== null) {
    const pct = Math.round(records.weekTrendRatio * 100);
    trendEl.textContent = `${pct >= 0 ? '▲ +' : '▼ '}${pct}%`;
    trendEl.className = pct >= 0 ? 'is-up' : 'is-down';
    trendNoteEl.textContent = pct >= 0 ? '较前 7 天升温' : '较前 7 天降温';
  } else {
    trendEl.textContent = '—';
    trendNoteEl.textContent = '需两周数据对比';
  }
}

function simulatedBurnRateForTemp(temp) {
  if (temp >= 100) return 85000;
  if (temp >= 80) return 45000;
  if (temp >= 58) return 22000;
  if (temp >= 35) return 8000;
  return 0;
}

function fireLabelForTemp(temp, burnRate) {
  if (!Number.isFinite(temp)) return '余烬待机';
  if (temp >= 100) return '蓝白电浆沸腾';
  if (temp >= 80) return '烈焰咆哮';
  if (temp >= 58) return '金橘聚能';
  if (temp >= 35 || burnRate > 0) return '初燃预热';
  return '余烬呼吸';
}

function ensureCrucibleMounted() {
  if (crucibleMounted || !window.TokemperatureCrucible) return;
  crucibleMounted = true;
  window.TokemperatureCrucible.mount({
    canvas: byId('crucible-canvas'),
    fallbackImg: byId('crucible-fallback'),
    stageEl: byId('crucible-stage')
  });
  window.TokemperatureCrucible.setPaused(document.hidden);
  if (lastCruciblePayload) {
    window.TokemperatureCrucible.updateState(lastCruciblePayload);
  }
}

function pushCruciblePayload(payload) {
  lastCruciblePayload = payload;
  ensureCrucibleMounted();
  window.TokemperatureCrucible?.updateState(payload);
}

function renderThermal() {
  const stats = state.summary;
  const today = stats?.periods?.today;
  const live = stats?.live || {
    tokensPerMin: 0, costUsdPerHour: 0, lastBurnAt: null,
    lastDeltaTokens: 0, lastDeltaAt: null, sparkline: Array(12).fill(0),
    burners: [], runningCount: 0, waitingCount: 0
  };
  const thermal = computeThermalState({
    todayTokens: today ? today.totalTokens : null,
    todayCostUsd: today ? today.costUsd : 0,
    historyDaily: state.history?.daily || [],
    todayDate: state.history?.end || null,
    burnRateTokensPerMin: live.tokensPerMin,
    lastBurnAt: live.lastBurnAt,
    nowMs: Date.now(),
    runningCount: live.runningCount,
    thermostat: state.thermostat,
    cnyRate: stats?.cnyQuote?.rate || 0
  });
  state.thermal = thermal;

  let displayTemp = thermal.displayTemp;
  let exactTemp = thermal.temperature;
  let tier = thermal.tier;
  let progressPercent = thermal.progressPercent;
  let burnRate = live.tokensPerMin;
  let burning = thermal.burning;
  let cooling = thermal.cooling;
  let previewBurners = live.burners || [];

  const previewChip = byId('preview-active-chip');
  if (state.preview.active) {
    exactTemp = state.preview.temp;
    displayTemp = Math.round(exactTemp);
    tier = tierForTemperature(exactTemp);
    burnRate = simulatedBurnRateForTemp(exactTemp);
    progressPercent = Math.round(Math.min(125, Math.max(2, ((exactTemp - 22) / 78) * 100)));
    burning = exactTemp >= 35;
    cooling = false;
    if (!previewBurners.length) {
      previewBurners = [
        { client: 'codex', project: 'tokemperature', model: 'gpt-5.4', state: exactTemp >= 35 ? 'running' : 'waiting', contextPercentUsed: 68 },
        { client: 'claude', project: 'crucible-core', model: 'claude-sonnet-4-6', state: exactTemp >= 58 ? 'running' : 'waiting', contextPercentUsed: 44 }
      ];
    }
    if (previewChip) previewChip.hidden = false;
    text('preview-temp-value', `${displayTemp}°C`);
  } else if (previewChip) {
    previewChip.hidden = true;
  }

  document.documentElement.dataset.heatTier = tier.id;

  const brandHg = byId('brand-mercury');
  if (brandHg) {
    const ratio = exactTemp === null ? 0.25 : Math.min(1, Math.max(0.1, (exactTemp - 20) / 100));
    const h = 3 + ratio * 11;
    brandHg.setAttribute('y', (17 - h).toFixed(1));
    brandHg.setAttribute('height', h.toFixed(1));
  }

  const heatPill = byId('heat-pill');
  heatPill.dataset.tier = tier.id;
  heatPill.classList.toggle('is-burning', burning);
  text('heat-pill-label', displayTemp !== null ? `${displayTemp}°C · ${tier.short}` : '—°C · 待机');

  const tempEl = byId('heat-temp');
  if (displayTemp !== null) {
    tempEl.textContent = `${displayTemp}°C`;
    tempEl.title = state.preview.active
      ? `试烧预览温度 ${displayTemp}°C`
      : `精确炉温 ${thermal.temperature.toFixed(1)}°C（基础 ${thermal.baseTemp.toFixed(1)}°C + 燃烧热度 +${thermal.liveBoost.toFixed(1)}°C）`;
  } else {
    tempEl.textContent = '—°C';
    tempEl.removeAttribute('title');
  }

  text('heat-tier-badge', cooling ? `${tier.label} · 散热中` : tier.label);
  text('fire-intensity-label', fireLabelForTemp(exactTemp, burnRate));

  const deltaEl = byId('heat-delta');
  if (!state.preview.active && thermal.deltaVsAvgC !== null) {
    deltaEl.hidden = false;
    deltaEl.className = `heat-delta ${thermal.deltaVsAvgC >= 0 ? 'is-hotter' : 'is-cooler'}`;
    deltaEl.textContent = `较30日均温 ${thermal.deltaVsAvgC >= 0 ? '+' : ''}${thermal.deltaVsAvgC}°C`;
  } else {
    deltaEl.hidden = true;
  }

  byId('heat-progress-bar').style.width = `${Math.min(100, Math.max(0, progressPercent))}%`;
  text('heat-target-note', state.preview.active
    ? `试烧模拟沸点进度：${progressPercent}%（${tier.label}）`
    : formatTargetSummary(thermal));

  text('burn-rate', `${formatTokenCount(burnRate)}/分`);
  const costRateEl = byId('burn-cost-rate');
  costRateEl.textContent = !state.preview.active && live.costUsdPerHour > 0
    ? `${formatEstimatedCost(live.costUsdPerHour, state.currency, stats?.cnyQuote?.rate)}/时`
    : state.preview.active && burnRate > 0 ? '试烧模拟' : '—';

  const burnStatus = byId('burn-status');
  burnStatus.className = 'burn-status';
  if (burning) {
    burnStatus.textContent = state.preview.active
      ? `试烧模拟 · ${tier.short}`
      : live.runningCount > 0 ? `正在燃烧 · ${live.runningCount} 路并发` : '正在燃烧';
    burnStatus.classList.add('is-burning');
  } else if (cooling) {
    burnStatus.textContent = '余温散热中';
    burnStatus.classList.add('is-cooling');
  } else {
    burnStatus.textContent = '炉膛待机';
  }

  drawSparkline(live.sparkline, tier);
  renderBurners({ ...live, burners: previewBurners });
  renderRecords(thermal.records);
  renderThermostatBanner(thermal);
  updateTabAndFavicon({ ...thermal, displayTemp, tier, burning });
  maybeNotifyThermostat(thermal);

  pushCruciblePayload({
    temperature: exactTemp ?? 22,
    tierId: tier.id,
    burnRateTokensPerMin: burnRate,
    progressPercent,
    cacheRatio: activeCacheRatio,
    burning,
    cooling,
    palette: state.palette,
    burners: previewBurners
  });
}

function renderStatus() {
  const stats = state.summary;
  let status = 'starting';
  let label = '准备采集';
  let message = '';
  if (state.offline) {
    status = 'error';
    label = '连接中断';
    message = '无法连接本地服务。连接恢复后将自动刷新。';
  } else if (stats?.state === 'error') {
    status = 'error';
    label = '采集异常';
    message = stats.message === 'scanner-unavailable' ? '扫描器未能启动。请查看运行终端，检查依赖与扫描器安装。' : '本次采集失败，详情见运行终端。';
    if (stats.periods) message += ' 页面保留上次成功数据。';
  } else if (stats?.mode === 'demo') {
    status = 'demo';
    label = '演示数据';
  } else if (stats?.state === 'paused') {
    status = 'paused';
    label = '采集已暂停';
  } else if (stats?.stale) {
    status = 'stale';
    label = '数据待更新';
  } else if (stats?.state === 'ready') {
    status = 'ready';
    label = '本机采集';
  }
  byId('status-pill').dataset.state = status;
  text('status-label', label);
  const date = stats?.lastSuccessAt && new Date(stats.lastSuccessAt);
  let checked = '等待采集结果';
  if (date && Number.isFinite(date.getTime())) {
    const formatted = new Intl.DateTimeFormat('zh-CN', {
      timeZone: stats.timeZone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
    }).format(date);
    checked = `${stats.mode === 'demo' ? '样例生成' : '最近采集'} ${formatted}`;
  }
  const clients = stats?.clients || [];
  const sources = clients.slice(0, 2).map(labelForTool).join('、');
  const selection = clients.length > 2 ? `${sources}等 ${clients.length} 个工具` : sources;
  text('source-note', [selection, checked].filter(Boolean).join(' · '));
  const banner = byId('message');
  banner.textContent = message;
  banner.hidden = !message;
  byId('download').hidden = !stats?.periods;
}

function renderComposition(period) {
  text('composition-period', periodLabels[state.selection]);
  const parts = components.filter(([id]) => id !== 'unclassifiedTokens' || period?.unclassifiedTokens);
  stack.replaceChildren(...parts.filter(([id]) => period?.[id] > 0).map(([id]) => {
    const segment = node('span');
    segment.dataset.part = id;
    segment.style.flexGrow = period[id];
    return segment;
  }));
  byId('components').replaceChildren(...parts.map(([id, label]) => {
    const row = node('li');
    row.dataset.part = id;
    const description = node('span', undefined, 'component-label');
    description.append(node('i', undefined, 'component-dot'), document.createTextNode(label));
    const count = node('span', undefined, 'component-count');
    showTokenCount(count, period?.[id]);
    row.append(description, count);
    return row;
  }));
}

function rankRows(period, projectsIncomplete) {
  if (!period) return [];
  const rows = period[state.dimension];
  if (state.dimension !== 'projects') return rows;
  const remaining = period.totalTokens - rows.reduce((sum, row) => sum + row.tokens, 0);
  if (remaining <= 0) return rows;
  return [...rows, {
    id: 'unattributed', label: projectsIncomplete ? '未归属或数据不完整' : '未归属', tokens: remaining,
    costUsd: Math.max(0, period.costUsd - rows.reduce((sum, row) => sum + row.costUsd, 0)),
    unpricedTokens: Math.max(0, period.unpricedTokens - rows.reduce((sum, row) => sum + row.unpricedTokens, 0))
  }].sort((a, b) => b.tokens - a.tokens);
}

function renderRanking() {
  const date = state.selectedDate;
  const day = state.dayDistribution;
  const period = date ? day?.period : state.summary?.periods?.[state.selection];
  rankDate.max = state.history?.end || '';
  if (document.activeElement !== rankDate && rankDate.value !== (date || '')) rankDate.value = date || '';
  byId('clear-rank-date').hidden = !date;
  const label = date || periodLabels[state.selection];
  const metric = date && period ? `${formatTokenCount(period.totalTokens)} Token` : '按 Token 用量排序';
  text('ranking-period', `${label} · ${metric}`);
  text('row-heading', dimensionLabels[state.dimension]);
  const table = byId('ranking-rows');
  const missingProjects = date && period && state.dimension === 'projects' && !day.projectsAvailable;
  const rows = missingProjects ? [] : rankRows(period, date ? day?.projectsIncomplete : state.summary?.projectsIncomplete);
  if (!rows.length) {
    let message = period ? '此周期暂无用量' : '等待此周期的统计';
    if (date) {
      if (missingProjects) message = '当天暂无可用的项目归属，请切换到工具或模型查看。';
      else if (period) message = period.totalTokens > 0 ? `当天暂无${dimensionLabels[state.dimension]}明细` : '当天没有记录到用量';
      else if (state.dayError) message = '读取当天用量失败，服务恢复后会重试。';
      else message = day ? '当天暂无用量统计' : '正在读取当天用量';
    }
    const cell = node('td', message, 'empty empty-row');
    cell.colSpan = 4;
    const tr = node('tr');
    tr.append(cell);
    table.replaceChildren(tr);
    return;
  }
  table.replaceChildren(...rows.map((row, index) => {
    const label = state.dimension === 'tools' ? labelForTool(row.id) : row.label ?? row.id;
    const name = node('td');
    const mark = node('span', label.charAt(0).toUpperCase(), 'tool-icon');
    mark.dataset.tool = row.id;
    mark.setAttribute('aria-hidden', 'true');
    const title = node('div', undefined, 'row-name');
    if (state.dimension === 'tools') title.append(mark);
    title.append(document.createTextNode(label));
    if (index === 0 && row.tokens > 0) title.append(node('span', '主热源', 'primary-source-badge'));
    name.append(title);
    const count = node('td', undefined, 'token-count');
    showTokenCount(count, row.tokens);
    const percentage = period.totalTokens > 0 ? Math.min(1, row.tokens / period.totalTokens) : 0;
    const share = node('td');
    const indicator = node('div', undefined, 'share');
    const progress = node('progress');
    progress.max = 1;
    progress.value = percentage;
    progress.setAttribute('aria-hidden', 'true');
    indicator.append(progress, node('span', percent.format(percentage)));
    share.append(indicator);
    const cost = node('td', priceOf(row));
    if (row.unpricedTokens) cost.title = `${formatExactTokenCount(row.unpricedTokens)} Token 缺少单价`;
    const entry = node('tr');
    entry.append(name, count, share, cost);
    return entry;
  }));
}

function triggerDeltaToast(delta) {
  const toast = byId('burn-delta-toast');
  clearTimeout(deltaHideTimer);
  toast.hidden = false;
  toast.textContent = `+${formatTokenCount(delta)} 🔥`;
  toast.style.animation = 'none';
  void toast.offsetWidth;
  toast.style.animation = '';
  deltaHideTimer = setTimeout(() => { toast.hidden = true; }, 2500);

  const strength = Math.min(1.15, 0.55 + Math.log10(Math.max(10, delta)) * 0.14);
  window.TokemperatureCrucible?.triggerSurge(strength);
}

function renderSummary() {
  renderStatus();
  const todayTokens = state.summary?.periods?.today?.totalTokens;
  const previousToday = lastSeenTodayTokens;
  if (Number.isFinite(todayTokens)) {
    if (previousToday !== null && todayTokens > previousToday) {
      triggerDeltaToast(todayTokens - previousToday);
    }
    lastSeenTodayTokens = todayTokens;
  }

  const period = state.summary?.periods?.[state.selection];
  const metricTokensEl = byId('metric-tokens');
  if (state.selection === 'today' && previousToday !== null && Number.isFinite(todayTokens) && todayTokens > previousToday) {
    animateTokenIncrease(metricTokensEl, previousToday, todayTokens);
  } else {
    showTokenCount(metricTokensEl, period?.totalTokens);
  }

  text('metric-tools', period ? `${period.tools.filter(row => row.tokens > 0).length} 个工具有用量` : '等待此周期的统计');
  text('metric-cost', period ? priceOf(period, period.totalTokens) : '—');
  const unpriced = byId('metric-unpriced');
  if (period?.unpricedTokens) showTokenCount(unpriced, period.unpricedTokens, ' Token 缺少单价');
  else {
    unpriced.textContent = '按已知模型单价计算';
    unpriced.removeAttribute('title');
  }
  const rateNote = byId('metric-exchange-rate');
  const quote = state.summary?.cnyQuote;
  rateNote.hidden = state.currency !== 'CNY' || !period || !quote;
  if (!rateNote.hidden) {
    rateNote.textContent = quote.reference ? '使用内置参考汇率' : quote.date ? `汇率 ${quote.date}` : '使用最近取得的汇率';
    rateNote.title = `1 USD ≈ ${quote.rate} CNY`;
  }
  text('ranking-currency', state.currency);

  const totalInput = period ? period.inputTokens + period.cacheReadTokens + period.cacheWriteTokens : 0;
  activeCacheRatio = totalInput ? Math.min(1, Math.max(0, period.cacheReadTokens / totalInput)) : 0;
  text('metric-cache', totalInput ? percent.format(activeCacheRatio) : '—');
  const cacheFill = byId('cache-bar-fill');
  if (cacheFill) cacheFill.style.width = `${(activeCacheRatio * 100).toFixed(1)}%`;

  renderComposition(period);
  renderRanking();
  renderThermal();
}

function trendDays() {
  return state.history?.daily.slice(-state.days) || [];
}

function historyOptions() {
  const daily = trendDays();
  const values = axis => [...new Set(daily.flatMap(row => Object.keys(row[axis] || {})))].sort();
  const options = [['all', '全部用量']];
  for (const id of values('tools')) options.push([`tools:${id}`, labelForTool(id)]);
  for (const id of values('models')) options.push([`models:${id}`, id]);
  const preferred = trendSource.value;
  if (options.map(([id]) => id).join('\n') !== Array.from(trendSource.options, item => item.value).join('\n')) {
    trendSource.replaceChildren(...options.map(([id, label]) => new Option(label, id)));
    if (options.some(([id]) => id === preferred)) trendSource.value = preferred;
  }
}

function chartValues() {
  const [axis, ...parts] = trendSource.value.split(':');
  const key = parts.join(':');
  return trendDays().map(row => ({
    date: row.date,
    tokens: row.tokens === null || axis === 'all' ? row.tokens : (row[axis]?.[key] ?? 0)
  }));
}

function drawChart() {
  const { width, height } = canvas.getBoundingClientRect();
  if (!width || !height) return;
  const data = chartValues();
  const available = data.some(row => row.tokens !== null);
  byId('chart-empty').hidden = available;
  const tooltip = byId('chart-tooltip');
  tooltip.hidden = true;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  if (!available) {
    canvas.setAttribute('aria-label', '暂无历史用量');
    chartGeometry = null;
    return;
  }

  const right = 5, top = 14, bottom = height - 29;
  const maximum = Math.max(1, ...data.map(row => row.tokens || 0));
  const power = 10 ** Math.floor(Math.log10(maximum));
  const limit = Math.ceil(maximum / (power / 2)) * power / 2;
  const ticks = Array.from({ length: 5 }, (_, index) => {
    const value = limit * index / 4;
    return { value, label: formatTokenCount(value) };
  });
  ctx.font = "12px 'Segoe UI', 'Microsoft YaHei', sans-serif";
  const labelWidth = Math.max(...ticks.map(({ label }) => ctx.measureText(label).width));
  const left = Math.max(32, Math.ceil(labelWidth) + 12);
  const range = width - left - right;
  const step = range / data.length;
  const y = value => bottom - value / limit * (bottom - top);
  chartGeometry = { left, range, step, length: data.length, top, bottom };
  const isCalm = state.palette === 'calm';
  const gridColor = isCalm ? '#273229' : '#2a201d';
  const textColor = isCalm ? '#98a69a' : '#a6928a';

  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const { value, label } of ticks) {
    ctx.beginPath();
    ctx.strokeStyle = gridColor;
    ctx.moveTo(left, y(value));
    ctx.lineTo(width - right, y(value));
    ctx.stroke();
    ctx.fillStyle = textColor;
    ctx.fillText(label, left - 8, y(value));
  }

  const records = state.thermal?.records;
  const avgTokens = trendSource.value === 'all' ? (records?.avg30Tokens || 0) : 0;
  let total = 0;
  const bar = Math.max(2, Math.min(41, step * 0.68));
  data.forEach((row, index) => {
    total += row.tokens || 0;
    const center = left + (index + 0.5) * step;
    const selected = row.date === state.selectedDate;
    if (index === state.hover || selected) {
      ctx.fillStyle = selected ? 'rgba(255, 168, 88, 0.14)' : 'rgba(255, 168, 88, 0.07)';
      ctx.fillRect(center - step / 2, top, step, bottom - top);
    }
    if (row.tokens > 0) {
      const valueY = y(row.tokens);
      const hotBar = selected || index === state.hover || index === data.length - 1 || (avgTokens > 0 && row.tokens >= avgTokens * 1.15);
      const grad = ctx.createLinearGradient(0, bottom, 0, valueY);
      if (isCalm) {
        grad.addColorStop(0, '#4a664b');
        grad.addColorStop(1, hotBar ? '#d8a665' : '#8bbf75');
      } else if (hotBar) {
        grad.addColorStop(0, '#7a2015');
        grad.addColorStop(0.55, '#ff682e');
        grad.addColorStop(1, '#ffe082');
      } else {
        grad.addColorStop(0, '#4f1b16');
        grad.addColorStop(1, '#c85c34');
      }
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.roundRect(center - bar / 2, valueY, bar, Math.max(1, bottom - valueY), [2, 2, 0, 0]);
      ctx.fill();
    }
    if (selected) {
      ctx.fillStyle = '#ffe082';
      ctx.fillRect(center - step / 2 + 1, bottom, Math.max(1, step - 2), 2);
    }
    const labelEvery = data.length <= 7 ? (width < 350 ? 2 : 1) : (width < 490 ? 7 : 5);
    if (index % labelEvery === 0 || (index === data.length - 1 && index % labelEvery > 1)) {
      ctx.textAlign = 'center';
      ctx.fillStyle = textColor;
      ctx.fillText(row.date.slice(5).replace('-', '/'), Math.min(width - 17, center), bottom + 16);
    }
  });

  if (avgTokens > 0) {
    const avgY = y(avgTokens);
    if (avgY >= top && avgY <= bottom) {
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = isCalm ? 'rgba(212, 176, 106, 0.7)' : 'rgba(255, 217, 125, 0.65)';
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(left, avgY);
      ctx.lineTo(width - right, avgY);
      ctx.stroke();
      ctx.restore();
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = isCalm ? '#d4b06a' : '#ffd97d';
      ctx.fillText(`30日均温 ${formatTokenCount(avgTokens)}`, width - right - 4, Math.max(top + 11, avgY - 3));
    }
  }

  const hovered = data[state.hover];
  const focusLabel = hovered ? `，${hovered.date} ${hovered.tokens === null ? '暂无数据' : `${formatExactTokenCount(hovered.tokens)} Token`}` : '';
  canvas.setAttribute('aria-label', `${data[0].date} 至 ${data.at(-1).date}，合计 ${formatExactTokenCount(total)} Token${focusLabel}`);
  if (hovered && state.hover !== null) {
    const display = formatTokenCount(hovered.tokens);
    const exact = formatExactTokenCount(hovered.tokens);
    let details = hovered.tokens === null ? '暂无数据' : `${display} Token${display === exact ? '' : `（${exact}）`}`;
    if (hovered.tokens !== null && trendSource.value === 'all' && records) {
      const est = estimateDayTemperature(hovered.tokens, records);
      const tier = tierForTemperature(est);
      details += ` · 约 ${Math.round(est)}°C（${tier.short}）`;
    }
    tooltip.textContent = `${hovered.date} · ${details}`;
    tooltip.hidden = false;
    const center = left + (state.hover + 0.5) * step;
    tooltip.style.left = `${Math.max(0, Math.min(width - tooltip.offsetWidth, center - tooltip.offsetWidth / 2))}px`;
  }
}

function renderHistory() {
  const daily = trendDays();
  text('trend-dates', daily.length ? `${daily[0].date} 至 ${daily.at(-1).date}` : '每日 Token');
  historyOptions();
  renderThermal();
  drawChart();
}

function renderHeatmapSelection() {
  const date = state.selectedDate;
  const daily = state.history?.daily || [];
  const buttons = Array.from(heatmapGrid.querySelectorAll('button'));
  const focused = heatmapGrid.contains(document.activeElement) ? document.activeElement : null;
  const current = focused || buttons.find(button => button.dataset.date === date) || buttons.at(-1);
  for (const button of buttons) {
    button.setAttribute('aria-pressed', String(button.dataset.date === date));
    button.tabIndex = button === current ? 0 : -1;
  }
  const row = daily.find(entry => entry.date === date);
  const value = row?.tokens ?? state.dayDistribution?.period?.totalTokens;
  text('heatmap-detail-date', date || '点击日期查看当日热力与分布');
  const detail = byId('heatmap-detail-value');
  const tempDetail = byId('heatmap-detail-temp');
  detail.hidden = !date;
  tempDetail.hidden = true;
  if (Number.isFinite(value)) {
    showTokenCount(detail, value, ' Token');
    if (value > 0 && state.thermal?.records) {
      const est = estimateDayTemperature(value, state.thermal.records);
      const tier = tierForTemperature(est);
      tempDetail.textContent = `热度约 ${Math.round(est)}°C · ${tier.label}`;
      tempDetail.hidden = false;
    }
  } else {
    detail.textContent = state.dayError ? '读取失败' : row || state.dayDistribution ? '暂无统计' : '读取中';
    detail.removeAttribute('title');
  }
}

function renderHeatmap() {
  const history = state.history;
  if (!history?.daily.length) return;
  const { daily } = history;
  const signature = daily.map(row => `${row.date}:${row.tokens}`).join('|');
  if (signature === heatmapSignature) return;
  heatmapSignature = signature;
  const focusedDate = heatmapGrid.contains(document.activeElement) ? document.activeElement.dataset.date : null;
  const firstWeekday = (new Date(`${history.start}T00:00:00Z`).getUTCDay() + 6) % 7;
  const weeks = Math.ceil((firstWeekday + daily.length) / 7);
  heatmapGrid.style.setProperty('--weeks', String(weeks));
  text('heatmap-range', `${history.start} 至 ${history.end}`);

  const labels = Array.from('一二三四五六日', (weekday, index) => {
    const label = node('span', weekday, 'heatmap-weekday');
    label.style.gridColumn = '1';
    label.style.gridRow = String(index + 2);
    return label;
  });
  const peak = Math.max(1, ...daily.map(row => row.tokens || 0));
  const months = new Map();
  const dots = daily.map(({ date, tokens }, index) => {
    const offset = firstWeekday + index;
    const column = Math.floor(offset / 7) + 2;
    if (index === 0 || date.endsWith('-01')) months.set(column, `${Number(date.slice(5, 7))}月`);
    const dot = node('button', undefined, 'heatmap-day');
    dot.type = 'button';
    dot.dataset.date = date;
    dot.dataset.level = tokens === null ? 'missing' : String(Math.ceil(4 * Math.sqrt(tokens / peak)));
    dot.style.gridColumn = String(column);
    dot.style.gridRow = String((offset % 7) + 2);
    dot.title = `${date} · ${tokens === null ? '暂无统计' : `${formatExactTokenCount(tokens)} Token`}`;
    dot.setAttribute('aria-label', dot.title);
    return dot;
  });
  const monthLabels = Array.from(months, ([column, month]) => {
    const label = node('span', month, 'heatmap-month');
    label.style.gridColumn = String(column);
    label.style.gridRow = '1';
    return label;
  });
  heatmapGrid.replaceChildren(...labels, ...monthLabels, ...dots);
  if (focusedDate) dots.find(dot => dot.dataset.date === focusedDate)?.focus({ preventScroll: true });
  renderHeatmapSelection();
}

async function json(url, signal) {
  const result = await fetch(url, { signal });
  if (!result.ok) throw new Error(`HTTP ${result.status}`);
  return result.json();
}

async function refreshDay() {
  dayRequest?.abort();
  const date = state.selectedDate;
  if (!date) return;
  const request = new AbortController();
  dayRequest = request;
  try {
    const result = await json(`/api/v1/distribution?date=${encodeURIComponent(date)}`, request.signal);
    if (request.signal.aborted) return;
    state.dayDistribution = result;
    state.dayError = false;
  } catch {
    if (request.signal.aborted) return;
    state.dayError = true;
  }
  renderRanking();
  renderHeatmapSelection();
}

function selectRankDate(date) {
  if (date && rankDate.max && date > rankDate.max) {
    rankDate.value = state.selectedDate || '';
    return;
  }
  if (state.selectedDate === date) return;
  state.selectedDate = date;
  state.dayDistribution = null;
  state.dayError = false;
  renderRanking();
  renderHeatmapSelection();
  drawChart();
  void refreshDay();
}

async function refresh() {
  currentRequest?.abort();
  const request = new AbortController();
  currentRequest = request;
  try {
    const [summary, history, thermostat] = await Promise.all([
      json('/api/v1/summary', request.signal),
      json('/api/v1/history?days=90', request.signal),
      json('/api/v1/thermostat', request.signal).catch(() => state.thermostat)
    ]);
    if (request.signal.aborted) return;
    state.summary = summary;
    state.history = history;
    if (thermostat && typeof thermostat.mode === 'string') state.thermostat = thermostat;
    state.offline = false;
    renderSummary();
    renderHistory();
    renderHeatmap();
    if (state.selectedDate) void refreshDay();
  } catch {
    if (request.signal.aborted) return;
    state.offline = true;
    renderStatus();
  }
}

function bindSegment(id, apply) {
  const group = byId(id);
  group.addEventListener('click', event => {
    const button = event.target.closest('button[data-value]');
    if (!button || button.getAttribute('aria-pressed') === 'true') return;
    for (const member of group.querySelectorAll('button')) member.setAttribute('aria-pressed', String(member === button));
    apply(button.dataset.value);
  });
}

function connect() {
  if (stream || document.hidden) return;
  stream = new EventSource('/api/v1/events');
  stream.onmessage = event => {
    const { revision } = JSON.parse(event.data);
    if (state.summary?.revision !== revision || state.offline) refresh();
  };
  stream.onerror = () => { if (!document.hidden) refresh(); };
}

function disconnect() {
  stream?.close();
  stream = undefined;
  currentRequest?.abort();
  dayRequest?.abort();
}

function updatePreviewButtons(temp) {
  for (const btn of document.querySelectorAll('[data-preview-temp]')) {
    const target = Number(btn.dataset.previewTemp);
    btn.setAttribute('aria-pressed', String(state.preview.active && Math.abs(target - temp) <= 6));
  }
}

function setPreviewActive(temp) {
  state.preview.active = true;
  state.preview.temp = Math.min(125, Math.max(22, Math.round(temp)));
  byId('preview-temp-slider').value = String(state.preview.temp);
  byId('preview-toggle').classList.add('is-active');
  updatePreviewButtons(state.preview.temp);
  renderThermal();
}

function exitPreviewMode() {
  state.preview.active = false;
  state.preview.panelOpen = false;
  byId('preview-panel').hidden = true;
  byId('preview-toggle').setAttribute('aria-expanded', 'false');
  byId('preview-toggle').classList.remove('is-active');
  updatePreviewButtons(-1);
  renderThermal();
}

applyPalette(state.palette);
byId('palette-toggle').addEventListener('click', () => {
  applyPalette(state.palette === 'calm' ? 'thermal' : 'calm');
  try { localStorage.setItem(PALETTE_KEY, state.palette); } catch { /* Keep current tab selection. */ }
  renderThermal();
  drawChart();
});

bindSegment('periods', selection => { state.selection = selection; renderSummary(); });
bindSegment('dimensions', dimension => { state.dimension = dimension; renderRanking(); });
bindSegment('ranges', days => { state.days = Number(days); state.hover = null; renderHistory(); });

costCurrency.value = state.currency;
costCurrency.addEventListener('change', () => {
  state.currency = normalizeCostCurrency(costCurrency.value);
  try { localStorage.setItem(COST_CURRENCY_KEY, state.currency); } catch { /* Keep the current tab selection. */ }
  renderSummary();
});

trendSource.addEventListener('change', () => { state.hover = null; drawChart(); });

function chartIndexAt(event) {
  const geometry = chartGeometry;
  if (!geometry) return null;
  const x = event.offsetX - geometry.left;
  return x < 0 || x >= geometry.range || event.offsetY > geometry.bottom || event.offsetY < geometry.top
    ? null : Math.min(geometry.length - 1, Math.floor(x / geometry.step));
}

canvas.addEventListener('pointermove', event => {
  const next = chartIndexAt(event);
  if (next !== state.hover) { state.hover = next; drawChart(); }
});
canvas.addEventListener('click', event => {
  const index = chartIndexAt(event);
  if (index !== null) selectRankDate(trendDays()[index].date);
});
canvas.addEventListener('keydown', event => {
  if (!chartGeometry) return;
  const daily = trendDays();
  const selected = daily.findIndex(row => row.date === state.selectedDate);
  const index = state.hover ?? (selected >= 0 ? selected : daily.length - 1);
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    selectRankDate(daily[index].date);
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    state.hover = Math.min(daily.length - 1, Math.max(0, index + (event.key === 'ArrowLeft' ? -1 : 1)));
    drawChart();
  }
});
canvas.addEventListener('pointerleave', () => { if (state.hover !== null) { state.hover = null; drawChart(); } });
canvas.addEventListener('blur', () => { if (state.hover !== null) { state.hover = null; drawChart(); } });

heatmapGrid.addEventListener('click', event => {
  const button = event.target.closest('button[data-date]');
  if (button) selectRankDate(button.dataset.date);
});
heatmapGrid.addEventListener('focusin', renderHeatmapSelection);
heatmapGrid.addEventListener('keydown', event => {
  const offsets = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 };
  const offset = offsets[event.key];
  if (!offset) return;
  const buttons = Array.from(heatmapGrid.querySelectorAll('button'));
  const index = buttons.indexOf(event.target);
  if (index < 0) return;
  event.preventDefault();
  buttons[index + offset]?.focus();
});

byId('record-peak-btn').addEventListener('click', () => {
  const peakDate = byId('record-peak-btn').dataset.date;
  if (!peakDate) return;
  selectRankDate(peakDate);
  byId('ranking-title')?.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'start' });
});

byId('scroll-analytics')?.addEventListener('click', () => {
  byId('analytics-section')?.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'start' });
});

// 3D Crucible camera presets
document.querySelector('.cam-presets')?.addEventListener('click', event => {
  const btn = event.target.closest('button[data-cam-preset]');
  if (!btn) return;
  for (const b of document.querySelectorAll('button[data-cam-preset]')) {
    b.setAttribute('aria-pressed', String(b === btn));
  }
  ensureCrucibleMounted();
  window.TokemperatureCrucible?.setCameraPreset(btn.dataset.camPreset);
});

// Test-Fire Preview drawer & controls
byId('preview-toggle')?.addEventListener('click', () => {
  if (state.preview.panelOpen) {
    exitPreviewMode();
  } else {
    state.preview.panelOpen = true;
    byId('preview-panel').hidden = false;
    byId('preview-toggle').setAttribute('aria-expanded', 'true');
  }
});

byId('preview-temp-slider')?.addEventListener('input', event => {
  setPreviewActive(Number(event.target.value));
});

byId('preview-panel')?.addEventListener('click', event => {
  const presetBtn = event.target.closest('button[data-preview-temp]');
  if (presetBtn) {
    setPreviewActive(Number(presetBtn.dataset.previewTemp));
  }
});

byId('preview-surge-btn')?.addEventListener('click', () => {
  ensureCrucibleMounted();
  window.TokemperatureCrucible?.triggerSurge(0.95);
  triggerDeltaToast(18400);
});

byId('preview-exit-btn')?.addEventListener('click', exitPreviewMode);

// Bidirectional Conduit highlighting from burner pills & conduit legend
const burnersStrip = byId('burners-strip');
burnersStrip?.addEventListener('pointerover', event => {
  const pill = event.target.closest('.burner-pill[data-conduit-idx]');
  setHighlightedConduit(pill ? Number(pill.dataset.conduitIdx) : -1);
});
burnersStrip?.addEventListener('pointerleave', () => setHighlightedConduit(-1));
burnersStrip?.addEventListener('focusin', event => {
  const pill = event.target.closest('.burner-pill[data-conduit-idx]');
  if (pill) setHighlightedConduit(Number(pill.dataset.conduitIdx));
});
burnersStrip?.addEventListener('focusout', () => setHighlightedConduit(-1));

const conduitLegend = byId('conduit-legend');
conduitLegend?.addEventListener('pointerover', event => {
  const chip = event.target.closest('.conduit-chip[data-conduit]');
  setHighlightedConduit(chip ? Number(chip.dataset.conduit) : -1);
});
conduitLegend?.addEventListener('pointerleave', () => setHighlightedConduit(-1));
conduitLegend?.addEventListener('click', event => {
  const chip = event.target.closest('.conduit-chip[data-conduit]');
  if (!chip) return;
  setHighlightedConduit(Number(chip.dataset.conduit));
  window.TokemperatureCrucible?.setCameraPreset('conduits');
  for (const b of document.querySelectorAll('button[data-cam-preset]')) {
    b.setAttribute('aria-pressed', String(b.dataset.camPreset === 'conduits'));
  }
});

rankDate.addEventListener('change', () => selectRankDate(rankDate.value || null));
byId('clear-rank-date').addEventListener('click', () => selectRankDate(null));
byId('download').addEventListener('click', event => { if (event.target.closest('a')) byId('download').open = false; });

document.addEventListener('visibilitychange', () => {
  window.TokemperatureCrucible?.setPaused(document.hidden);
  if (document.hidden) disconnect();
  else { connect(); refresh(); }
});
document.addEventListener('tools-saved', refresh);
document.addEventListener('thermostat-saved', event => {
  if (event.detail) state.thermostat = event.detail;
  renderThermal();
});
document.addEventListener('crucible-ready', () => {
  if (lastCruciblePayload) window.TokemperatureCrucible?.updateState(lastCruciblePayload);
});
window.addEventListener('load', ensureCrucibleMounted);
window.addEventListener('pagehide', disconnect);
window.addEventListener('pageshow', connect);

let chartResizeRaf = 0;
new ResizeObserver(() => {
  cancelAnimationFrame(chartResizeRaf);
  chartResizeRaf = requestAnimationFrame(drawChart);
}).observe(byId('chart-wrap'));
let sparkResizeRaf = 0;
new ResizeObserver(() => {
  cancelAnimationFrame(sparkResizeRaf);
  sparkResizeRaf = requestAnimationFrame(() => {
    if (state.thermal) drawSparkline(state.summary?.live?.sparkline, state.thermal.tier);
  });
}).observe(byId('sparkline-wrap'));

setInterval(() => {
  if (!document.hidden && state.summary && !state.preview.active) renderThermal();
}, 10000);
setInterval(() => { if (!document.hidden) refresh(); }, 30000);

ensureCrucibleMounted();
renderSummary();
connect();
refresh();
