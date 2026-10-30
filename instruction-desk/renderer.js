const $ = (id) => document.getElementById(id);
const log = $('log');
const emptyHero = $('emptyHero');
const chatScrollArea = $('chatScrollArea');
const inputEl = $('input');
const sendBtn = $('send');
const settingsModal = $('settingsModal');
const inputDock = $('inputDock');
const attachBtn = $('attachBtn');
const fileInput = $('fileInput');
const attachmentTray = $('attachmentTray');
const micBtn = $('micBtn');
const micLabel = $('micLabel');

let busy = false;
let streamingEl = null;
let currentToolWidget = null;
let currentTabs = [];
let selectedTabId = null;
let autoApprove = localStorage.getItem('naviq_auto_approve') === 'true';

// ---- Voice Command State ----
let isVoiceListening = false;
let speechRecognizer = null;
let voiceMediaStream = null;
let voiceMediaRecorder = null;
let voiceAudioChunks = [];

// ---- File Attachments State ----
let pendingAttachments = [];

// ---- Chat History State ----
let currentSessionId = generateSessionId();
let currentMessages = [];

function generateSessionId() {
  return 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}

// Provider presets with dual-model quota configurations
const PRESETS = {
  gemini: {
    name: 'Gemini 3.1 Flash Lite',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-3.1-flash-lite',
    fallbackModel: 'gemini-3.5-flash-lite',
    match: 'generativelanguage.googleapis.com'
  },
  openrouter: {
    name: 'OpenRouter (Llama 3.3)',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'meta-llama/llama-3.3-70b-instruct:free',
    fallbackModel: 'google/gemini-2.0-flash-exp:free',
    match: 'openrouter.ai'
  },
  openai: {
    name: 'OpenAI (GPT-4o mini)',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    fallbackModel: 'gpt-3.5-turbo',
    match: 'api.openai.com'
  },
  local: {
    name: 'Local Ollama (Llama 3.2)',
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.2',
    fallbackModel: 'llama3.1',
    match: 'localhost:11434'
  },
  custom: {
    name: 'Custom Model',
    fallbackModel: ''
  }
};
const PRESET_MODELS = new Set(Object.values(PRESETS).map((p) => p.model).filter(Boolean));

const parseKeys = (raw) =>
  [...new Set(String(raw || '').split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean))];

const detectProvider = (url) => {
  const u = String(url || '').toLowerCase();
  for (const [key, p] of Object.entries(PRESETS)) if (p.match && u.includes(p.match)) return key;
  return 'custom';
};

const settings = () => ({
  provider: $('provider').value,
  baseUrl: $('baseUrl').value.trim(),
  apiKeys: parseKeys($('apiKeys').value),
  model: $('model').value.trim(),
  fallbackModel: $('fallbackModel').value.trim()
});

function updateModelLabels() {
  const m = $('model').value.trim() || 'Gemini 3.1 Flash Lite';
  const display = m.length > 25 ? m.slice(0, 22) + '...' : m;
  $('activeModelLabel').textContent = display;
  $('topModelDisplay').textContent = display;
  $('keysCountChip').textContent = `${parseKeys($('apiKeys').value).length} keys`;
}

function persist() {
  const s = settings();
  localStorage.setItem('settings', JSON.stringify(s));
  window.agent?.setStorage('settings', s);
  window.agent?.syncSettings(s);
  updateModelLabels();
}

function applySettings(s) {
  if (!s || typeof s !== 'object') return;
  const keys = Array.isArray(s.apiKeys) ? s.apiKeys : s.apiKey ? [s.apiKey] : [];
  if (s.provider && PRESETS[s.provider]) {
    $('provider').value = s.provider;
  } else if (s.baseUrl) {
    $('provider').value = detectProvider(s.baseUrl);
  }
  if (s.baseUrl) $('baseUrl').value = s.baseUrl;
  if (keys.length) $('apiKeys').value = keys.join('\n');
  if (s.model) $('model').value = s.model;
  if (s.fallbackModel) $('fallbackModel').value = s.fallbackModel;
  persist();
}

// Initial settings load from localStorage
const saved = JSON.parse(localStorage.getItem('settings') || '{}');
applySettings(saved);

// ---- Chrome Profile State & Handlers ----
let chromeProfiles = [];
let currentProfileId = 'Default';

async function initChromeProfiles() {
  try {
    const profiles = (await window.agent?.getChromeProfiles()) || [];
    chromeProfiles = profiles;
    const diskProfile = (await window.agent?.getStorage('chrome_profile')) || (await window.agent?.getActiveChromeProfile()) || 'Default';
    currentProfileId = diskProfile;
    populateProfileDropdowns(profiles, diskProfile);
  } catch (err) {
    console.warn('[profiles] initChromeProfiles failed:', err);
  }
}

function populateProfileDropdowns(profiles, activeId) {
  const topSelect = $('chromeProfileSelect');
  const modalSelect = $('modalChromeProfileSelect');

  const renderOpts = (el) => {
    if (!el) return;
    el.innerHTML = '';
    for (const p of profiles) {
      const opt = document.createElement('option');
      opt.value = p.id;
      const label = p.email ? `${p.name} (${p.email})` : p.name;
      opt.textContent = label;
      if (p.id === activeId) opt.selected = true;
      el.appendChild(opt);
    }
  };

  renderOpts(topSelect);
  renderOpts(modalSelect);
}

async function handleProfileChange(newProfileId) {
  currentProfileId = newProfileId;
  const topSelect = $('chromeProfileSelect');
  const modalSelect = $('modalChromeProfileSelect');
  if (topSelect && topSelect.value !== newProfileId) topSelect.value = newProfileId;
  if (modalSelect && modalSelect.value !== newProfileId) modalSelect.value = newProfileId;

  await window.agent?.setStorage('chrome_profile', newProfileId);
  const found = chromeProfiles.find((p) => p.id === newProfileId);
  const name = found ? (found.email ? `${found.name} (${found.email})` : found.name) : newProfileId;
  addNotice(`Switching to Chrome profile: ${name}...`);
  const res = await window.agent?.launchBrowser(newProfileId);
  if (res && !res.ok) {
    addError(`Failed to switch profile: ${res.error}`);
  }
}

if ($('chromeProfileSelect')) {
  $('chromeProfileSelect').onchange = (e) => handleProfileChange(e.target.value);
}
if ($('modalChromeProfileSelect')) {
  $('modalChromeProfileSelect').onchange = (e) => handleProfileChange(e.target.value);
}

// Persistent disk storage hydration (survives app closing/reopening)
async function initPersistentStorage() {
  try {
    const diskSettings = await window.agent?.getStorage('settings');
    if (diskSettings && typeof diskSettings === 'object' && Object.keys(diskSettings).length > 0) {
      applySettings(diskSettings);
    }
    const diskSessions = await window.agent?.getStorage('naviq_sessions');
    if (Array.isArray(diskSessions) && diskSessions.length > 0) {
      localStorage.setItem('naviq_sessions', JSON.stringify(diskSessions));
      renderHistory();
    }
    const diskAuto = await window.agent?.getStorage('naviq_auto_approve');
    if (diskAuto !== undefined && diskAuto !== null) {
      setAutoApprove(diskAuto === true, false);
    }
    await initChromeProfiles();
  } catch (err) {
    console.warn('[storage] initPersistentStorage failed:', err);
  }
}
initPersistentStorage();

// ---- Provider change events ----
$('provider').onchange = () => {
  const p = PRESETS[$('provider').value];
  if (!p || !p.baseUrl) return;
  $('baseUrl').value = p.baseUrl;
  const m = $('model').value.trim();
  if (!m || PRESET_MODELS.has(m)) {
    $('model').value = p.model;
    $('fallbackModel').value = p.fallbackModel || '';
  }
  updateModelLabels();
};
$('baseUrl').addEventListener('input', () => {
  const d = detectProvider($('baseUrl').value.trim());
  if ($('provider').value !== d) $('provider').value = d;
  updateModelLabels();
});
$('model').addEventListener('input', updateModelLabels);
$('fallbackModel').addEventListener('input', persist);
$('apiKeys').addEventListener('input', () => {
  $('keysCountChip').textContent = `${parseKeys($('apiKeys').value).length} keys`;
});

// ---- Settings Modal Controls ----
function openSettings() {
  settingsModal.hidden = false;
  $('apiKeys').focus();
}
function closeSettings() {
  settingsModal.hidden = true;
}
$('settingsBtn').onclick = openSettings;
$('modelPill').onclick = openSettings;
$('modalCloseBtn').onclick = closeSettings;
$('modalCancelBtn').onclick = closeSettings;
$('save').onclick = () => {
  persist();
  closeSettings();
  addNotice('Settings saved successfully to disk.');
};

// ---- Auto-Approve Mode Controls ----
function updateAutoApproveUi() {
  const bottomBtn = $('bottomAutoApproveBtn');
  const bottomLabel = $('bottomAutoApproveLabel');
  const setting = $('autoApproveSetting');
  if (autoApprove) {
    bottomBtn?.classList.add('enabled');
    if (bottomLabel) bottomLabel.textContent = 'Auto-Approve: ON';
    if (setting) setting.checked = true;
  } else {
    bottomBtn?.classList.remove('enabled');
    if (bottomLabel) bottomLabel.textContent = 'Auto-Approve: OFF';
    if (setting) setting.checked = false;
  }
}

function setAutoApprove(val, showToast = true) {
  autoApprove = !!val;
  localStorage.setItem('naviq_auto_approve', String(autoApprove));
  window.agent?.setStorage('naviq_auto_approve', autoApprove);
  updateAutoApproveUi();
  if (showToast) {
    addNotice(
      autoApprove
        ? '⚡ Auto-Approve enabled: actions will proceed automatically.'
        : 'Auto-Approve disabled: sensitive actions will prompt for confirmation.'
    );
  }
}

$('bottomAutoApproveBtn').onclick = () => setAutoApprove(!autoApprove);
const autoSettingEl = $('autoApproveSetting');
if (autoSettingEl) {
  autoSettingEl.onchange = (e) => setAutoApprove(e.target.checked);
}
updateAutoApproveUi();

// ---- Sidebar Collapse / Expand ----
const sidebar = $('sidebar');
const sidebarToggleBtn = $('sidebarToggleBtn');
const sidebarOpenBtn = $('sidebarOpenBtn');

sidebarToggleBtn.onclick = () => {
  sidebar.classList.add('collapsed');
  sidebarOpenBtn.style.display = 'inline-flex';
};
sidebarOpenBtn.onclick = () => {
  sidebar.classList.remove('collapsed');
  sidebarOpenBtn.style.display = 'none';
};

// ---- Browser Launch Handlers ----
async function handleLaunch() {
  const profileId = $('chromeProfileSelect')?.value || currentProfileId || 'Default';
  const found = chromeProfiles.find((p) => p.id === profileId);
  const name = found ? (found.email ? `${found.name} (${found.email})` : found.name) : profileId;
  addNotice(`Launching Chrome (Profile: ${name})...`);
  const res = await window.agent.launchBrowser(profileId);
  if (!res.ok) addError(`Launch failed: ${res.error}`);
}
$('launchBtn').onclick = handleLaunch;
$('topLaunchBtn').onclick = handleLaunch;

// ---- Tab Selection Logic ----
function selectTab(id) {
  selectedTabId = id;
  const bottomLabel = $('bottomTargetTabLabel');
  const bottomDot = $('bottomTargetTabDot');

  if (selectedTabId === null || selectedTabId === '') {
    selectedTabId = null;
    if (bottomLabel) bottomLabel.textContent = 'Auto Tab';
    if (bottomDot) bottomDot.style.display = 'none';
  } else {
    const found = currentTabs.find(t => String(t.id) === String(selectedTabId));
    const title = found?.title || `Tab #${selectedTabId}`;
    const truncated = title.length > 16 ? title.slice(0, 14) + '...' : title;
    if (bottomLabel) bottomLabel.textContent = truncated;
    if (bottomDot) bottomDot.style.display = 'inline-block';
  }
  renderTabs(currentTabs);
}

$('bottomTargetTabBtn').onclick = () => {
  if (selectedTabId !== null) {
    selectTab(null);
    addNotice('Target tab reset to Auto (Free context).');
  } else {
    addNotice('Auto Tab active: NaviQ operates across any open or active Chrome tab.');
  }
};

function renderTabs(tabs) {
  currentTabs = Array.isArray(tabs) ? tabs : [];
  const bar = $('tabBar');
  const countBadge = $('tabCountBadge');
  bar.innerHTML = '';
  countBadge.textContent = `${currentTabs.length} tabs`;

  // Always render Auto Tab as the first option
  const autoItem = document.createElement('div');
  const isAutoSelected = selectedTabId === null;
  autoItem.className = `tab-item ${isAutoSelected ? 'selected-target' : ''}`;
  autoItem.title = 'Free Context: NaviQ operates across any open or active tab';
  autoItem.innerHTML = `
    <span class="tab-dot"></span>
    <span class="tab-title">Auto (Active Tab / Free)</span>
    ${isAutoSelected ? '<span class="tab-target-badge">TARGET</span>' : ''}
  `;
  autoItem.onclick = () => selectTab(null);
  bar.appendChild(autoItem);

  if (currentTabs.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'empty-tabs-hint';
    hint.textContent = 'Launch Chrome to monitor tabs';
    bar.appendChild(hint);
    return;
  }

  for (const t of currentTabs) {
    const item = document.createElement('div');
    const isSelected = selectedTabId !== null && String(selectedTabId) === String(t.id);
    item.className = `tab-item ${isSelected ? 'selected-target' : ''}`;
    item.title = `${t.title || 'Tab'} (${t.url || ''})`;

    const dot = document.createElement('span');
    dot.className = 'tab-dot';

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = t.title || t.url || `Tab ${t.id || ''}`;

    item.appendChild(dot);
    item.appendChild(title);

    if (isSelected) {
      const badge = document.createElement('span');
      badge.className = 'tab-target-badge';
      badge.textContent = 'TARGET';
      item.appendChild(badge);
    }

    item.onclick = () => selectTab(t.id);
    bar.appendChild(item);
  }
}

// ---- File Upload & Attachments Management ----
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsText(file);
  });
}

async function handleFiles(files) {
  if (!files || !files.length) return;
  for (const file of Array.from(files)) {
    if (file.size > 25 * 1024 * 1024) {
      addError(`File "${file.name}" exceeds 25 MB limit.`);
      continue;
    }
    const id = 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const isImage = file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|svg)$/i.test(file.name);

    try {
      if (isImage) {
        const dataUrl = await readFileAsDataUrl(file);
        const commaIdx = dataUrl.indexOf(',');
        const dataBase64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
        pendingAttachments.push({
          id,
          name: file.name,
          mimeType: file.type || 'image/png',
          size: file.size,
          dataBase64,
          previewUrl: dataUrl
        });
      } else {
        const isText =
          file.type.startsWith('text/') ||
          /\.(txt|md|json|js|ts|py|html|css|csv|xml|yaml|yml|log)$/i.test(file.name);
        if (isText) {
          const text = await readFileAsText(file);
          pendingAttachments.push({
            id,
            name: file.name,
            mimeType: file.type || 'text/plain',
            size: file.size,
            dataText: text,
            previewUrl: null
          });
        } else {
          const dataUrl = await readFileAsDataUrl(file);
          const commaIdx = dataUrl.indexOf(',');
          const dataBase64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
          pendingAttachments.push({
            id,
            name: file.name,
            mimeType: file.type || 'application/octet-stream',
            size: file.size,
            dataBase64,
            previewUrl: null
          });
        }
      }
    } catch (err) {
      console.error('[upload] error reading file:', file.name, err);
      addError(`Failed to read file: ${file.name}`);
    }
  }
  renderAttachmentTray();
}

function removeAttachment(id) {
  pendingAttachments = pendingAttachments.filter((a) => a.id !== id);
  renderAttachmentTray();
}

function renderAttachmentTray() {
  if (!attachmentTray) return;
  if (pendingAttachments.length === 0) {
    attachmentTray.hidden = true;
    attachmentTray.innerHTML = '';
    return;
  }

  attachmentTray.hidden = false;
  attachmentTray.innerHTML = '';

  for (const a of pendingAttachments) {
    const card = document.createElement('div');
    card.className = 'attachment-card';

    if (a.previewUrl) {
      const img = document.createElement('img');
      img.className = 'attachment-thumb';
      img.src = a.previewUrl;
      card.appendChild(img);
    } else {
      const icon = document.createElement('div');
      icon.className = 'attachment-file-icon';
      icon.textContent = '📄';
      card.appendChild(icon);
    }

    const info = document.createElement('div');
    info.className = 'attachment-info';

    const name = document.createElement('span');
    name.className = 'attachment-name';
    name.textContent = a.name;
    name.title = a.name;

    const size = document.createElement('span');
    size.className = 'attachment-size';
    size.textContent = formatBytes(a.size);

    info.appendChild(name);
    info.appendChild(size);
    card.appendChild(info);

    const delBtn = document.createElement('button');
    delBtn.className = 'attachment-del-btn';
    delBtn.textContent = '✕';
    delBtn.title = 'Remove file';
    delBtn.onclick = () => removeAttachment(a.id);
    card.appendChild(delBtn);

    attachmentTray.appendChild(card);
  }
}

attachBtn.onclick = () => fileInput.click();
fileInput.onchange = (e) => {
  handleFiles(e.target.files);
  fileInput.value = '';
};

// Drag & Drop on input dock
inputDock.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.stopPropagation();
  inputDock.classList.add('drag-over');
});
inputDock.addEventListener('dragleave', (e) => {
  e.preventDefault();
  e.stopPropagation();
  inputDock.classList.remove('drag-over');
});
inputDock.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  inputDock.classList.remove('drag-over');
  if (e.dataTransfer?.files?.length) {
    handleFiles(e.dataTransfer.files);
  }
});

// ---- Voice Command & Speech Recognition ----
function setMicListeningState(listening, label = 'Voice') {
  isVoiceListening = listening;
  if (micBtn) {
    if (listening) {
      micBtn.classList.add('listening');
      micBtn.title = 'Listening... Click to stop and run';
    } else {
      micBtn.classList.remove('listening');
      micBtn.title = 'Voice command (Click to speak)';
    }
  }
  if (micLabel) {
    micLabel.textContent = label;
  }
}

async function stopVoiceRecording() {
  if (speechRecognizer) {
    try { speechRecognizer.stop(); } catch {}
  }
  if (voiceMediaRecorder && voiceMediaRecorder.state !== 'inactive') {
    try { voiceMediaRecorder.stop(); } catch {}
  }
  if (voiceMediaStream) {
    voiceMediaStream.getTracks().forEach((t) => t.stop());
    voiceMediaStream = null;
  }
  setMicListeningState(false, 'Voice');
}

async function startVoiceCommand() {
  if (isVoiceListening) {
    await stopVoiceRecording();
    return;
  }

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let useFallback = !SpeechRecognition;

  if (SpeechRecognition) {
    try {
      speechRecognizer = new SpeechRecognition();
      speechRecognizer.continuous = false;
      speechRecognizer.interimResults = true;
      speechRecognizer.lang = 'en-US';

      speechRecognizer.onstart = () => {
        setMicListeningState(true, 'Listening...');
        addNotice('🎙️ Listening... Speak your command.');
      };

      speechRecognizer.onresult = (e) => {
        let transcript = '';
        for (let i = 0; i < e.results.length; i++) {
          transcript += e.results[i][0].transcript;
        }
        if (transcript) {
          inputEl.value = transcript;
          inputEl.style.height = 'auto';
          inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + 'px';
        }
      };

      speechRecognizer.onend = () => {
        setMicListeningState(false, 'Voice');
        const text = inputEl.value.trim();
        if (text) {
          addNotice(`🎙️ Voice command: "${text}"`);
          run();
        }
      };

      speechRecognizer.onerror = async (err) => {
        console.warn('[voice] SpeechRecognition error:', err.error);
        try { speechRecognizer.stop(); } catch {}
        speechRecognizer = null;
        setMicListeningState(false, 'Voice');

        if (err.error === 'network' || err.error === 'not-allowed' || err.error === 'service-not-allowed') {
          // Native fallback to MediaRecorder + Gemini
          await startAudioFallback();
        } else if (err.error !== 'no-speech') {
          addError(`Microphone error: ${err.error}`);
        }
      };

      speechRecognizer.start();
      return;
    } catch (e) {
      console.warn('[voice] SpeechRecognition init failed, using fallback:', e);
      useFallback = true;
    }
  }

  if (useFallback) {
    await startAudioFallback();
  }
}

async function startAudioFallback() {
  try {
    voiceMediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    voiceAudioChunks = [];
    voiceMediaRecorder = new MediaRecorder(voiceMediaStream, {
      mimeType: MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4'
    });

    voiceMediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) voiceAudioChunks.push(e.data);
    };

    voiceMediaRecorder.onstop = async () => {
      setMicListeningState(false, 'Transcribing...');
      const audioBlob = new Blob(voiceAudioChunks, { type: voiceMediaRecorder.mimeType || 'audio/webm' });
      voiceAudioChunks = [];
      if (voiceMediaStream) {
        voiceMediaStream.getTracks().forEach((t) => t.stop());
        voiceMediaStream = null;
      }

      if (audioBlob.size < 1000) {
        setMicListeningState(false, 'Voice');
        return;
      }

      await transcribeAudioBlob(audioBlob);
    };

    voiceMediaRecorder.start();
    setMicListeningState(true, 'Recording... (Click to stop)');
    addNotice('🎙️ Recording voice... Speak clearly, then click Voice again when done.');
  } catch (err) {
    console.error('[voice] getUserMedia error:', err);
    addError(`Microphone access error: ${err.message || 'Permission denied'}`);
    setMicListeningState(false, 'Voice');
  }
}

async function transcribeAudioBlob(audioBlob) {
  const s = settings();
  const keys = s.apiKeys;
  if (!keys || keys.length === 0) {
    addError('Voice transcription requires an API key in settings.');
    setMicListeningState(false, 'Voice');
    return;
  }

  addNotice('🎙️ Transcribing voice command with Gemini...');
  try {
    const base64Audio = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const res = reader.result;
        const comma = res.indexOf(',');
        resolve(comma >= 0 ? res.slice(comma + 1) : res);
      };
      reader.onerror = reject;
      reader.readAsDataURL(audioBlob);
    });

    const cleanMime = (audioBlob.type || 'audio/webm').split(';')[0].trim() || 'audio/webm';
    const res = await window.agent.transcribeAudio({
      base64Audio,
      mimeType: cleanMime,
      settings: s
    });

    if (!res.ok) {
      throw new Error(res.error || 'Transcription failed');
    }

    const transcribedText = res.text?.trim();

    if (transcribedText) {
      inputEl.value = transcribedText;
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + 'px';
      addNotice(`🎙️ Voice command recognized: "${transcribedText}"`);
      setMicListeningState(false, 'Voice');
      run();
    } else {
      addError('No speech detected in audio.');
      setMicListeningState(false, 'Voice');
    }
  } catch (err) {
    console.error('[voice] transcribeAudioBlob failed:', err);
    addError(`Voice transcription failed: ${err.message}`);
    setMicListeningState(false, 'Voice');
  }
}

if (micBtn) {
  micBtn.onclick = () => {
    if (isVoiceListening) {
      stopVoiceRecording();
    } else {
      startVoiceCommand();
    }
  };
}

// ---- Chat History Management ----
function getSavedSessions() {
  try {
    return JSON.parse(localStorage.getItem('naviq_sessions') || '[]');
  } catch {
    return [];
  }
}

function saveCurrentSession() {
  if (currentMessages.length === 0) return;
  const sessions = getSavedSessions();
  const firstUserMsg = currentMessages.find((m) => m.role === 'user');
  const rawTitle = firstUserMsg ? firstUserMsg.text : 'New Conversation';
  const title = rawTitle.length > 32 ? rawTitle.slice(0, 30) + '...' : rawTitle;

  const existingIndex = sessions.findIndex((s) => s.id === currentSessionId);
  const sessionData = {
    id: currentSessionId,
    title,
    updatedAt: Date.now(),
    messages: currentMessages
  };

  if (existingIndex >= 0) {
    sessions[existingIndex] = sessionData;
  } else {
    sessions.unshift(sessionData);
  }

  const trimmed = sessions.slice(0, 50);
  localStorage.setItem('naviq_sessions', JSON.stringify(trimmed));
  window.agent?.setStorage('naviq_sessions', trimmed);
  renderHistory();
}

function deleteSession(sessionId, e) {
  if (e) e.stopPropagation();
  const sessions = getSavedSessions().filter((s) => s.id !== sessionId);
  localStorage.setItem('naviq_sessions', JSON.stringify(sessions));
  window.agent?.setStorage('naviq_sessions', sessions);

  if (currentSessionId === sessionId) {
    startNewChat();
  } else {
    renderHistory();
  }
}

function clearAllHistory() {
  if (confirm('Clear all conversation history?')) {
    localStorage.removeItem('naviq_sessions');
    window.agent?.setStorage('naviq_sessions', []);
    startNewChat();
    renderHistory();
    addNotice('Chat history cleared.');
  }
}
$('clearHistoryBtn').onclick = clearAllHistory;

function loadSession(sessionId) {
  const sessions = getSavedSessions();
  const found = sessions.find((s) => s.id === sessionId);
  if (!found) return;

  currentSessionId = found.id;
  currentMessages = Array.isArray(found.messages) ? found.messages : [];

  log.innerHTML = '';
  hideHero();
  setBusy(false);
  streamingEl = null;
  currentToolWidget = null;

  for (const m of currentMessages) {
    if (m.role === 'user') {
      renderUserMessageBubble(m.text, m.attachments);
    } else if (m.role === 'assistant') {
      renderAssistantBubble(m.text);
    } else if (m.role === 'tool') {
      addToolExecution(m.name, m.args, false);
    } else if (m.role === 'tool-result') {
      completeToolExecution(m.name, m.result, false);
    } else if (m.role === 'notice') {
      renderNoticePill(m.text);
    } else if (m.role === 'error') {
      renderErrorPill(m.text);
    }
  }

  renderHistory();
  scrollToBottom();
}

function renderHistory() {
  const container = $('historyList');
  const sessions = getSavedSessions();
  container.innerHTML = '';

  if (sessions.length === 0) {
    container.innerHTML = '<div class="empty-history-hint">No past conversations</div>';
    return;
  }

  for (const s of sessions) {
    const item = document.createElement('div');
    const isActive = s.id === currentSessionId;
    item.className = `history-item ${isActive ? 'active' : ''}`;

    const title = document.createElement('span');
    title.className = 'history-item-title';
    title.textContent = s.title;

    const delBtn = document.createElement('button');
    delBtn.className = 'history-delete-btn';
    delBtn.title = 'Delete chat';
    delBtn.textContent = '✕';
    delBtn.onclick = (e) => deleteSession(s.id, e);

    item.appendChild(title);
    item.appendChild(delBtn);
    item.onclick = () => loadSession(s.id);
    container.appendChild(item);
  }
}

// Initial history render
renderHistory();

// ---- New Chat Handler ----
function startNewChat() {
  void window.agent.newChat();
  currentSessionId = generateSessionId();
  currentMessages = [];
  pendingAttachments = [];
  renderAttachmentTray();
  log.innerHTML = '';
  emptyHero.style.display = 'flex';
  setBusy(false);
  streamingEl = null;
  currentToolWidget = null;
  inputEl.value = '';
  inputEl.focus();
  renderHistory();
}
$('newChatBtn').onclick = startNewChat;

// ---- Prompt Suggestion Cards ----
document.querySelectorAll('.prompt-card').forEach((card) => {
  card.onclick = () => {
    const prompt = card.getAttribute('data-prompt');
    if (prompt) {
      inputEl.value = prompt;
      run();
    }
  };
});

// Auto-expand textarea
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + 'px';
});

const SEND_ICON_HTML = `
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <line x1="12" y1="19" x2="12" y2="5"></line>
    <polyline points="5 12 12 5 19 12"></polyline>
  </svg>
`;

const PAUSE_ICON_HTML = `
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <rect x="5" y="4" width="4" height="16" rx="1.5"></rect>
    <rect x="15" y="4" width="4" height="16" rx="1.5"></rect>
  </svg>
`;

function setBusy(state) {
  busy = state;
  if (busy) {
    sendBtn.classList.add('pause-mode');
    sendBtn.title = 'Pause / Stop agent';
    sendBtn.innerHTML = PAUSE_ICON_HTML;
  } else {
    sendBtn.classList.remove('pause-mode');
    sendBtn.title = 'Send message';
    sendBtn.innerHTML = SEND_ICON_HTML;
  }
}

function scrollToBottom() {
  chatScrollArea.scrollTop = chatScrollArea.scrollHeight;
}

// Tool Icons Helper
function getToolIcon(name) {
  switch (name) {
    case 'navigate': return '🌐';
    case 'click': return '🖱️';
    case 'input_text':
    case 'type': return '⌨️';
    case 'scroll': return '📜';
    case 'search': return '🔍';
    case 'extract':
    case 'read': return '📄';
    case 'upload': return '📤';
    default: return '⚡';
  }
}

// UI Message Appenders
function hideHero() {
  if (emptyHero.style.display !== 'none') {
    emptyHero.style.display = 'none';
  }
}

function renderUserMessageBubble(text, attachments = []) {
  hideHero();
  const row = document.createElement('div');
  row.className = 'msg-row user';
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  if (attachments && attachments.length > 0) {
    const gallery = document.createElement('div');
    gallery.className = 'msg-attachments';
    for (const a of attachments) {
      const item = document.createElement('div');
      item.className = 'msg-attachment-item';
      if (a.previewUrl) {
        const img = document.createElement('img');
        img.className = 'msg-attachment-thumb';
        img.src = a.previewUrl;
        item.appendChild(img);
      } else {
        const icon = document.createElement('span');
        icon.textContent = '📄 ';
        item.appendChild(icon);
      }
      const label = document.createElement('span');
      label.textContent = a.name;
      item.appendChild(label);
      gallery.appendChild(item);
    }
    bubble.appendChild(gallery);
  }

  if (text) {
    const textEl = document.createElement('div');
    textEl.textContent = text;
    bubble.appendChild(textEl);
  }

  row.appendChild(bubble);
  log.appendChild(row);
  scrollToBottom();
}

function addUserMessage(text, attachments = []) {
  currentMessages.push({ role: 'user', text, attachments });
  saveCurrentSession();
  renderUserMessageBubble(text, attachments);
}

function renderAssistantBubble(text) {
  hideHero();
  const row = document.createElement('div');
  row.className = 'msg-row bot';

  const avatar = document.createElement('img');
  avatar.src = 'assets/icon-32.png';
  avatar.className = 'msg-avatar';
  avatar.alt = 'NaviQ';

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.textContent = text;

  row.appendChild(avatar);
  row.appendChild(bubble);
  log.appendChild(row);
  scrollToBottom();
  return bubble;
}

function addAssistantMessage(text) {
  currentMessages.push({ role: 'assistant', text });
  saveCurrentSession();
  return renderAssistantBubble(text);
}

function addToolExecution(name, args, record = true) {
  hideHero();
  if (record) {
    currentMessages.push({ role: 'tool', name, args });
    saveCurrentSession();
  }

  const widget = document.createElement('div');
  widget.className = 'tool-widget';

  const header = document.createElement('div');
  header.className = 'tool-header';

  const info = document.createElement('div');
  info.className = 'tool-info';

  const icon = document.createElement('span');
  icon.className = 'tool-icon';
  icon.textContent = getToolIcon(name);

  const nameEl = document.createElement('span');
  nameEl.className = 'tool-name';
  nameEl.textContent = name;

  const pill = document.createElement('span');
  pill.className = 'tool-status-pill running';
  pill.textContent = 'running...';

  info.appendChild(icon);
  info.appendChild(nameEl);
  header.appendChild(info);
  header.appendChild(pill);

  const body = document.createElement('div');
  body.className = 'tool-body';
  body.textContent = typeof args === 'object' ? JSON.stringify(args, null, 2) : String(args || '');

  header.onclick = () => {
    body.hidden = !body.hidden;
  };

  widget.appendChild(header);
  widget.appendChild(body);
  log.appendChild(widget);
  scrollToBottom();

  currentToolWidget = { widget, pill, body, name };
  return widget;
}

function completeToolExecution(name, result, record = true) {
  if (record) {
    currentMessages.push({ role: 'tool-result', name, result });
    saveCurrentSession();
  }
  if (currentToolWidget && currentToolWidget.name === name) {
    const isOk = result?.ok !== false;
    currentToolWidget.pill.className = `tool-status-pill ${isOk ? 'success' : 'failed'}`;
    currentToolWidget.pill.textContent = isOk ? 'completed ✓' : 'failed ✕';
    if (!isOk) {
      currentToolWidget.body.textContent += `\n\nError: ${result?.error || 'Execution failed'}`;
    }
    currentToolWidget = null;
  }
}

function renderNoticePill(text) {
  hideHero();
  const notice = document.createElement('div');
  notice.className = 'notice-pill';
  notice.innerHTML = `<span>✨</span><span>${text}</span>`;
  log.appendChild(notice);
  scrollToBottom();
}

function addNotice(text) {
  currentMessages.push({ role: 'notice', text });
  saveCurrentSession();
  renderNoticePill(text);
}

function renderErrorPill(text) {
  hideHero();
  const err = document.createElement('div');
  err.className = 'err-pill';
  err.textContent = text;
  log.appendChild(err);
  scrollToBottom();
}

function addError(text) {
  currentMessages.push({ role: 'error', text });
  saveCurrentSession();
  renderErrorPill(text);
}

function showPrompt(prompt) {
  if (autoApprove) {
    const isConfirmOrWrite = prompt.kind === 'write-card' || prompt.kind === 'confirm';
    const answer = isConfirmOrWrite ? 'allow-once' : 'given-back';
    window.agent.answer(prompt.id, answer);
    const title = prompt.data?.title || prompt.kind || 'Action';
    addNotice(`⚡ Auto-approved: ${title}`);
    $('promptCard').hidden = true;
    return;
  }

  const card = $('promptCard');
  const title = $('promptTitle');
  const content = $('promptContent');
  const actions = $('promptActions');

  title.textContent = prompt.data?.title || `Approval required (${prompt.kind})`;
  content.textContent = prompt.data?.question || prompt.data?.description || JSON.stringify(prompt.data || {});
  actions.innerHTML = '';

  if (prompt.kind === 'write-card' || prompt.kind === 'confirm') {
    const allowBtn = document.createElement('button');
    allowBtn.className = 'btn-allow';
    allowBtn.textContent = 'Allow Action';
    allowBtn.onclick = () => {
      window.agent.answer(prompt.id, 'allow-once');
      card.hidden = true;
    };
    const denyBtn = document.createElement('button');
    denyBtn.className = 'btn-deny';
    denyBtn.textContent = 'Deny';
    denyBtn.onclick = () => {
      window.agent.answer(prompt.id, 'deny');
      card.hidden = true;
    };
    actions.append(allowBtn, denyBtn);
  } else {
    const continueBtn = document.createElement('button');
    continueBtn.className = 'btn-allow';
    continueBtn.textContent = 'Continue';
    continueBtn.onclick = () => {
      window.agent.answer(prompt.id, 'given-back');
      card.hidden = true;
    };
    actions.appendChild(continueBtn);
  }
  card.hidden = false;
  card.scrollIntoView({ behavior: 'smooth' });
}

// Extension and Desktop Event Listener
window.agent.onEvent((ev) => {
  if (ev.type === 'browser-status') {
    const badge = $('statusBadge');
    const text = $('statusText');
    const isConn = ev.status === 'connected';
    badge.className = `badge ${isConn ? 'connected' : 'disconnected'}`;
    text.textContent = isConn ? 'Connected' : 'Disconnected';
    if (ev.tabs) renderTabs(ev.tabs);
  } else if (ev.type === 'tabs') {
    renderTabs(ev.tabs);
  } else if (ev.type === 'tool') {
    addToolExecution(ev.name, ev.args);
  } else if (ev.type === 'tool-result') {
    completeToolExecution(ev.name, ev.result);
  } else if (ev.type === 'notice') {
    addNotice(ev.text);
    if (ev.text.includes('Switched to key') || ev.text.includes('Switched to API Key')) {
      const keys = parseKeys($('apiKeys').value);
      if (keys.length > 1) {
        const rotated = [...keys.slice(1), keys[0]];
        $('apiKeys').value = rotated.join('\n');
        persist();
      }
    }
  } else if (ev.type === 'streaming') {
    if (!streamingEl) {
      streamingEl = renderAssistantBubble('');
    }
    streamingEl.textContent = ev.text;
    scrollToBottom();
  } else if (ev.type === 'assistant') {
    if (streamingEl) {
      streamingEl.textContent = ev.text;
      streamingEl = null;
      currentMessages.push({ role: 'assistant', text: ev.text });
      saveCurrentSession();
    } else {
      addAssistantMessage(ev.text);
    }
  } else if (ev.type === 'stopped') {
    streamingEl = null;
    addNotice('Agent stopped.');
    setBusy(false);
  } else if (ev.type === 'idle') {
    streamingEl = null;
    setBusy(false);
  } else if (ev.type === 'err') {
    streamingEl = null;
    addError(`Error: ${ev.error}`);
    setBusy(false);
    if (ev.error && (ev.error.includes('429') || ev.error.includes('RESOURCE_EXHAUSTED') || ev.error.includes('quota'))) {
      const keys = parseKeys($('apiKeys').value);
      if (keys.length > 1) {
        const rotated = [...keys.slice(1), keys[0]];
        $('apiKeys').value = rotated.join('\n');
        persist();
        addNotice(`Rotated API key on quota limit. Next attempt will use key 2 of ${keys.length}.`);
      }
    }
  } else if (ev.type === 'prompt') {
    showPrompt(ev.prompt);
  } else if (ev.type === 'prompt_closed') {
    $('promptCard').hidden = true;
  }
});

async function run() {
  const text = inputEl.value.trim();
  if ((!text && pendingAttachments.length === 0) || busy) return;

  const s = settings();
  if (s.provider !== 'local' && (!s.apiKeys || s.apiKeys.length === 0)) {
    addError('No API key set! Opening settings dialog...');
    openSettings();
    return;
  }

  const attachmentsToSend = [...pendingAttachments];
  pendingAttachments = [];
  renderAttachmentTray();

  setBusy(true);
  streamingEl = null;
  persist();
  addUserMessage(text || (attachmentsToSend.length ? `[Uploaded ${attachmentsToSend.length} file(s)]` : ''), attachmentsToSend);
  inputEl.value = '';
  inputEl.style.height = 'auto';

  const res = await window.agent.run(text, s, selectedTabId, attachmentsToSend);
  if (!res.ok) {
    addError(`Execution error: ${res.error}`);
    setBusy(false);
  }
}

sendBtn.onclick = () => {
  if (busy) {
    window.agent.stop();
    addNotice('Pausing agent run...');
    setBusy(false);
  } else {
    run();
  }
};

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    run();
  }
});
