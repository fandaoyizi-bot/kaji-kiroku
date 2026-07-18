// 訪問作業記録アプリ 本体
// データはすべて端末内の IndexedDB に保存。外部送信は一切しない。

const VALUABLES_LABEL = '現金・通帳・印鑑・カード・その他貴重品';
const LOCATION_OPTIONS = ['居間', '台所', 'トイレ', 'お風呂', '床の間', '書斎', '寝室', '客間', '玄関'];

// ─── 画面状態 ───
let currentRecordId = null;   // 詳細表示中のID
let editingId = null;         // 編集中のID（新規はnull）
let formBlocks = [];          // 作業ブロック {location, content, photosBefore:[], photosAfter:[]}
                              // 写真: {kind:'new', blob, url} | {kind:'existing', fileId, url}
let formAudios = [];          // {kind, blob?, fileId?, label, url}
let objectUrls = [];          // 後で解放するURL

// ─── ユーティリティ ───
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function trackUrl(url) { objectUrls.push(url); return url; }
function revokeUrls() { objectUrls.forEach(u => URL.revokeObjectURL(u)); objectUrls = []; }

function newRecordId() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const rand = Math.random().toString(36).slice(2, 6);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${rand}`;
}

function fmtDateTime(v) {
  // 'YYYY-MM-DDTHH:MM' → '2026年8月3日(月) 10:00'
  if (!v) return '（未入力）';
  const d = new Date(v);
  if (isNaN(d)) return v;
  const youbi = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日(${youbi}) ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtISO(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function nowLocalInput() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 旧形式のレコードを現行形式に揃える
// ・作業場所・内容・写真が日報直下 → work_blocks へ
// ・貴重品が5項目別チェック → 1問形式（valuables_touched）へ
function normalizeRecord(r) {
  if (!r.work_blocks) {
    r.work_blocks = [{
      location: r.location || '',
      content: r.work_content || '',
      photos_before: r.photos_before || [],
      photos_after: r.photos_after || [],
    }];
  }
  if (!r.valuables_touched) {
    if (r.valuables) {
      const touched = Object.keys(r.valuables).filter(k => r.valuables[k] === '触れた');
      r.valuables_touched = touched.length ? '触れた' : '触れていない';
      if (touched.length) {
        r.valuables_note = [touched.join('・') + 'に接触', r.valuables_note].filter(Boolean).join('：');
      }
    } else {
      r.valuables_touched = '触れていない';
    }
  }
  return r;
}

function blockLocations(r) {
  return normalizeRecord(r).work_blocks.map(b => b.location).filter(Boolean).join('・') || '場所未記入';
}

// ─── 画面切替 ───
function switchView(id) {
  revokeUrls();
  document.querySelectorAll('.view').forEach(v => v.hidden = true);
  document.getElementById(id).hidden = false;
  window.scrollTo(0, 0);
}

async function showHome() {
  switchView('view-home');
  await renderRecordList();
  renderStorageInfo();
}

function showSettings() {
  document.getElementById('backup-status').textContent = '';
  document.getElementById('restore-status').textContent = '';
  switchView('view-settings');
}

// ─── ホーム：記録一覧 ───
async function renderRecordList() {
  const listEl = document.getElementById('record-list');
  const records = await dbGetAll('records');
  records.sort((a, b) => (b.visit_start || '').localeCompare(a.visit_start || ''));
  if (records.length === 0) {
    listEl.innerHTML = '<p class="empty-msg">まだ記録がありません。<br>「＋ 新しい日報を作る」から始めてください。</p>';
    return;
  }
  listEl.innerHTML = records.map(r => {
    normalizeRecord(r);
    const badge = r.valuables_touched === '触れた'
      ? `<span class="badge warn">貴重品接触あり</span>`
      : `<span class="badge ok">貴重品接触なし</span>`;
    const edited = r.modified_at ? `<span class="badge edited">修正あり</span>` : '';
    return `<button class="record-card" onclick="showDetail('${esc(r.id)}')">
      <div class="rc-date">${esc(fmtDateTime(r.visit_start))}</div>
      <div class="rc-sub">${esc(blockLocations(r))}${badge}${edited}</div>
    </button>`;
  }).join('');
}

async function renderStorageInfo() {
  const el = document.getElementById('storage-info');
  try {
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      const mb = (est.usage / 1024 / 1024).toFixed(1);
      const cnt = (await dbGetAllKeys('records')).length;
      el.textContent = `記録 ${cnt} 件 ／ 使用容量 約 ${mb} MB（端末内保存）`;
    }
  } catch { /* 非対応環境では表示しない */ }
}

// ─── フォーム ───
function renderValuables(touchedValue) {
  const v = touchedValue || '触れていない';
  const area = document.getElementById('valuables-area');
  area.innerHTML = `<div class="val-row">
      <span class="val-name">${esc(VALUABLES_LABEL)}</span>
      <span class="val-choices">
        <label class="${v === '触れていない' ? 'nottouched-selected' : ''}">
          <input type="radio" name="val-touched" value="触れていない" ${v === '触れていない' ? 'checked' : ''}>触れていない
        </label>
        <label class="${v === '触れた' ? 'touched-selected' : ''}">
          <input type="radio" name="val-touched" value="触れた" ${v === '触れた' ? 'checked' : ''}>触れた
        </label>
      </span>
    </div>`;
  document.getElementById('val-detail').hidden = v !== '触れた';
  area.querySelectorAll('input[type="radio"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const row = radio.closest('.val-row');
      row.querySelectorAll('label').forEach(l => l.classList.remove('touched-selected', 'nottouched-selected'));
      radio.closest('label').classList.add(radio.value === '触れた' ? 'touched-selected' : 'nottouched-selected');
      document.getElementById('val-detail').hidden = radio.value !== '触れた';
    });
  });
}

// 作業ブロック
function newEmptyBlock() {
  return { location: '', content: '', photosBefore: [], photosAfter: [], otherMode: false };
}

function onBlockLocationChange(i, value) {
  if (value === 'その他') {
    formBlocks[i].otherMode = true;
    formBlocks[i].location = '';
  } else {
    formBlocks[i].otherMode = false;
    formBlocks[i].location = value;
  }
  renderBlocks();
}

function addBlock() {
  formBlocks.push(newEmptyBlock());
  renderBlocks();
}

function removeBlock(i) {
  const b = formBlocks[i];
  const hasContent = b.location || b.content || b.photosBefore.length || b.photosAfter.length;
  if (hasContent && !confirm(`作業${i + 1}（${b.location || '場所未記入'}）を取り消しますか？`)) return;
  formBlocks.splice(i, 1);
  if (formBlocks.length === 0) formBlocks.push(newEmptyBlock());
  renderBlocks();
}

function photoThumbsHtml(arr, blockIndex, side) {
  return arr.map((p, j) => `<span class="photo-thumb">
      <img src="${p.url}" alt="写真">
      <button type="button" class="remove-btn" onclick="removeBlockPhoto(${blockIndex}, '${side}', ${j})" aria-label="削除">✕</button>
    </span>`).join('');
}

function renderBlocks() {
  const area = document.getElementById('blocks-area');
  area.innerHTML = formBlocks.map((b, i) => {
    const otherMode = b.otherMode || (b.location !== '' && !LOCATION_OPTIONS.includes(b.location));
    const selectValue = otherMode ? 'その他' : b.location;
    return `
    <div class="work-block">
      <div class="wb-head">
        <span class="wb-title">作業${i + 1}</span>
        ${formBlocks.length > 1 ? `<button type="button" class="remove-btn" style="position:static;" onclick="removeBlock(${i})" aria-label="取り消し">✕</button>` : ''}
      </div>
      <label class="field-label">場所</label>
      <select class="input" onchange="onBlockLocationChange(${i}, this.value)">
        <option value="" ${selectValue === '' ? 'selected' : ''} disabled>選択してください</option>
        ${LOCATION_OPTIONS.map(opt => `<option value="${esc(opt)}" ${selectValue === opt ? 'selected' : ''}>${esc(opt)}</option>`).join('')}
        <option value="その他" ${selectValue === 'その他' ? 'selected' : ''}>その他</option>
      </select>
      ${otherMode ? `<input type="text" class="input" style="margin-top:0.5rem" placeholder="場所を入力" value="${esc(b.location)}" oninput="formBlocks[${i}].location = this.value">` : ''}
      <label class="field-label">作業内容</label>
      <textarea class="textarea" rows="4" placeholder="マイクボタンで音声入力もできます" oninput="formBlocks[${i}].content = this.value">${esc(b.content)}</textarea>
      <label class="field-label">作業前の写真</label>
      <input type="file" accept="image/*" multiple class="file-input" onchange="handleBlockPhotoInput(this, ${i}, 'photosBefore')">
      <div class="photo-preview">${photoThumbsHtml(b.photosBefore, i, 'photosBefore')}</div>
      <label class="field-label">作業後の写真</label>
      <input type="file" accept="image/*" multiple class="file-input" onchange="handleBlockPhotoInput(this, ${i}, 'photosAfter')">
      <div class="photo-preview">${photoThumbsHtml(b.photosAfter, i, 'photosAfter')}</div>
    </div>`;
  }).join('');
}

async function handleBlockPhotoInput(inputEl, blockIndex, side) {
  for (const file of inputEl.files) {
    const blob = await compressImage(file);
    formBlocks[blockIndex][side].push({ kind: 'new', blob, url: trackUrl(URL.createObjectURL(blob)) });
  }
  inputEl.value = '';
  renderBlocks();
}

function removeBlockPhoto(blockIndex, side, j) {
  formBlocks[blockIndex][side].splice(j, 1);
  renderBlocks();
}

async function showForm(recordId) {
  editingId = recordId || null;
  formBlocks = [];
  formAudios = [];
  stopRecordingIfActive();

  document.getElementById('form-title').textContent = editingId ? '日報の修正' : '新しい日報';
  document.getElementById('edit-notice').hidden = !editingId;
  document.getElementById('f-audio-file').value = '';
  document.getElementById('rec-status').textContent = '';

  if (editingId) {
    const r = normalizeRecord(await dbGet('records', editingId));
    document.getElementById('f-start').value = r.visit_start || '';
    document.getElementById('f-end').value = r.visit_end || '';
    document.getElementById('f-moved').value = r.moved_items || '';
    document.getElementById('f-disposed').value = r.disposed_items || '';
    document.getElementById('f-valnote').value = r.valuables_note || '';
    renderValuables(r.valuables_touched);
    for (const wb of r.work_blocks) {
      const loc = wb.location || '';
      const block = { location: loc, content: wb.content || '', photosBefore: [], photosAfter: [], otherMode: loc !== '' && !LOCATION_OPTIONS.includes(loc) };
      for (const fid of wb.photos_before || []) {
        const f = await dbGet('files', fid);
        if (f) block.photosBefore.push({ kind: 'existing', fileId: fid, url: trackUrl(URL.createObjectURL(f.blob)) });
      }
      for (const fid of wb.photos_after || []) {
        const f = await dbGet('files', fid);
        if (f) block.photosAfter.push({ kind: 'existing', fileId: fid, url: trackUrl(URL.createObjectURL(f.blob)) });
      }
      formBlocks.push(block);
    }
    for (const a of r.audios || []) {
      const f = await dbGet('files', a.fileId);
      if (f) formAudios.push({ kind: 'existing', fileId: a.fileId, label: a.label, url: trackUrl(URL.createObjectURL(f.blob)) });
    }
  } else {
    document.getElementById('f-start').value = nowLocalInput();
    document.getElementById('f-end').value = '';
    document.getElementById('f-moved').value = '';
    document.getElementById('f-disposed').value = '';
    document.getElementById('f-valnote').value = '';
    renderValuables(null);
    formBlocks.push(newEmptyBlock());
  }
  renderBlocks();
  renderAudioList();
  switchView('view-form');
}

function confirmLeaveForm() {
  if (confirm('入力途中の内容は保存されません。戻りますか？')) {
    stopRecordingIfActive();
    if (editingId) showDetail(editingId); else showHome();
  }
}

// 写真圧縮
async function compressImage(file) {
  try {
    const url = URL.createObjectURL(file);
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = url;
    });
    const MAX = 1600;
    let { width, height } = img;
    if (Math.max(width, height) > MAX) {
      const scale = MAX / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    canvas.getContext('2d').drawImage(img, 0, 0, width, height);
    URL.revokeObjectURL(url);
    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.7));
    return blob || file;
  } catch {
    return file; // 圧縮に失敗したら元ファイルをそのまま使う
  }
}

// 音声
let mediaRecorder = null;
let recChunks = [];
let recTimer = null;
let recStartTime = 0;

function stopRecordingIfActive() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  clearInterval(recTimer);
  const btn = document.getElementById('btn-record');
  btn.classList.remove('recording');
  btn.textContent = '🎤 終了時確認を録音';
}

async function toggleRecording() {
  const btn = document.getElementById('btn-record');
  const status = document.getElementById('rec-status');

  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    alert('この環境では録音機能が使えません。ボイスメモで録音し、「音声ファイルを添付」から追加してください。');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4'
      : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
    mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    recChunks = [];
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      clearInterval(recTimer);
      btn.classList.remove('recording');
      btn.textContent = '🎤 終了時確認を録音';
      status.textContent = '';
      if (recChunks.length) {
        const blob = new Blob(recChunks, { type: mediaRecorder.mimeType || 'audio/mp4' });
        formAudios.push({ kind: 'new', blob, label: '終了時確認', url: trackUrl(URL.createObjectURL(blob)) });
        renderAudioList();
      }
    };
    mediaRecorder.start();
    recStartTime = Date.now();
    btn.classList.add('recording');
    btn.textContent = '⏹ 録音を止める';
    recTimer = setInterval(() => {
      const sec = Math.floor((Date.now() - recStartTime) / 1000);
      status.textContent = `録音中 ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    }, 500);
  } catch (err) {
    alert('マイクを使用できませんでした。設定でマイクの許可を確認してください。\n' + err.message);
  }
}

function handleAudioFileInput(inputEl) {
  for (const file of inputEl.files) {
    formAudios.push({ kind: 'new', blob: file, label: '作業メモ', url: trackUrl(URL.createObjectURL(file)) });
  }
  inputEl.value = '';
  renderAudioList();
}

function renderAudioList() {
  document.getElementById('audio-list').innerHTML = formAudios.map((a, i) =>
    `<div class="audio-item">
      <div class="audio-head">
        <select onchange="formAudios[${i}].label = this.value" style="font-size:1rem; padding:0.3rem;">
          <option value="終了時確認" ${a.label === '終了時確認' ? 'selected' : ''}>終了時確認</option>
          <option value="作業メモ" ${a.label === '作業メモ' ? 'selected' : ''}>作業メモ</option>
        </select>
        <button type="button" class="remove-btn" style="position:static;" onclick="removeAudio(${i})" aria-label="削除">✕</button>
      </div>
      <audio controls src="${a.url}"></audio>
    </div>`).join('');
}

function removeAudio(index) {
  formAudios.splice(index, 1);
  renderAudioList();
}

// 保存
async function saveRecord() {
  const start = document.getElementById('f-start').value;
  if (!start) { alert('訪問開始日時を入力してください。'); return; }

  const touchedEl = document.querySelector('input[name="val-touched"]:checked');
  const valuablesTouched = touchedEl ? touchedEl.value : '触れていない';
  const valNote = document.getElementById('f-valnote').value.trim();
  if (valuablesTouched === '触れた' && !valNote) {
    alert('貴重品に触れた場合は、何に・どんな事情で触れたかを記入してください。');
    return;
  }

  stopRecordingIfActive();
  // 録音停止の完了（onstopでの追加）を待つ
  await new Promise(r => setTimeout(r, 300));

  const storeAttachment = async (entry, prefix) => {
    if (entry.kind === 'existing') return entry.fileId;
    const fileId = `${prefix}-${crypto.randomUUID()}`;
    await dbPut('files', { fileId, blob: entry.blob, type: entry.blob.type });
    return fileId;
  };

  const workBlocks = [];
  for (const b of formBlocks) {
    const photosBefore = [];
    for (const p of b.photosBefore) photosBefore.push(await storeAttachment(p, 'photo'));
    const photosAfter = [];
    for (const p of b.photosAfter) photosAfter.push(await storeAttachment(p, 'photo'));
    workBlocks.push({
      location: b.location.trim(),
      content: b.content.trim(),
      photos_before: photosBefore,
      photos_after: photosAfter,
    });
  }

  const audios = [];
  for (const a of formAudios) audios.push({ fileId: await storeAttachment(a, 'audio'), label: a.label });

  const nowIso = new Date().toISOString();
  let record;
  if (editingId) {
    record = await dbGet('records', editingId);
    const snapshot = { ...record };
    delete snapshot.history;
    record.history = record.history || [];
    record.history.push({ saved_at: nowIso, snapshot });
    record.modified_at = nowIso;
    // 旧形式のフィールドが残っていたら消して現行形式に一本化
    delete record.location; delete record.work_content;
    delete record.photos_before; delete record.photos_after;
    delete record.valuables;
  } else {
    record = { id: newRecordId(), created_at: nowIso, modified_at: null, history: [] };
  }

  Object.assign(record, {
    visit_start: start,
    visit_end: document.getElementById('f-end').value,
    work_blocks: workBlocks,
    moved_items: document.getElementById('f-moved').value.trim(),
    disposed_items: document.getElementById('f-disposed').value.trim(),
    valuables_touched: valuablesTouched,
    valuables_note: valuablesTouched === '触れた' ? valNote : '',
    audios,
  });

  await dbPut('records', record);
  editingId = null;
  await showDetail(record.id);
  alert('保存しました。');
}

// ─── 詳細画面 ───
async function showDetail(recordId) {
  currentRecordId = recordId;
  const raw = await dbGet('records', recordId);
  if (!raw) { showHome(); return; }
  const r = normalizeRecord(raw);
  switchView('view-detail');
  document.getElementById('share-box').hidden = true;
  document.getElementById('copy-status').textContent = '';

  const touched = r.valuables_touched === '触れた';

  const photoHtml = async (fids, caption) => {
    if (!fids?.length) return `<p class="meta-text">${caption}：なし</p>`;
    let html = `<h3>${caption}（${fids.length}枚）</h3><div class="detail-photos">`;
    for (const fid of fids) {
      const f = await dbGet('files', fid);
      if (f) {
        const url = trackUrl(URL.createObjectURL(f.blob));
        html += `<img src="${url}" alt="${caption}" onclick="openLightbox('${url}')">`;
      }
    }
    return html + '</div>';
  };

  let blocksHtml = '';
  for (let i = 0; i < r.work_blocks.length; i++) {
    const b = r.work_blocks[i];
    const title = r.work_blocks.length > 1 ? `作業${i + 1}：` : '';
    blocksHtml += `<div class="detail-block">
      <h3>${esc(title)}${esc(b.location || '場所未記入')}</h3>
      <p>${esc(b.content || '（未記入）')}</p>
      ${await photoHtml(b.photos_before, '作業前の写真')}
      ${await photoHtml(b.photos_after, '作業後の写真')}
    </div>`;
  }

  let audioHtml = '';
  if (r.audios?.length) {
    audioHtml = '<div class="detail-block"><h3>音声</h3>';
    for (const a of r.audios) {
      const f = await dbGet('files', a.fileId);
      if (f) {
        const url = trackUrl(URL.createObjectURL(f.blob));
        audioHtml += `<p class="meta-text">${esc(a.label)}</p><audio controls src="${url}"></audio>`;
      }
    }
    audioHtml += '</div>';
  }

  let historyHtml = '';
  if (r.history?.length) {
    historyHtml = `<div class="detail-block"><details><summary>修正履歴（${r.history.length}件）</summary>` +
      r.history.map((h, i) => {
        const s = normalizeRecord({ ...h.snapshot });
        const workSummary = s.work_blocks.map(b =>
          `${b.location || '場所未記入'}：${b.content || '（空欄）'}`).join(' ／ ');
        return `<div class="history-item">
          <strong>修正 ${i + 1}</strong>（${esc(fmtISO(h.saved_at))} に修正）<br>
          修正前の作業内容：${esc(workSummary)}<br>
          修正前の移動した物：${esc(s.moved_items || '（空欄）')}<br>
          修正前の処分した物：${esc(s.disposed_items || '（空欄）')}
        </div>`;
      }).join('') + '</details></div>';
  }

  document.getElementById('detail-body').innerHTML = `
    <div class="detail-block">
      <h3>訪問日時</h3>
      <p>${esc(fmtDateTime(r.visit_start))} 〜 ${esc(r.visit_end ? fmtDateTime(r.visit_end) : '（未入力）')}</p>
    </div>
    ${blocksHtml}
    <div class="detail-block"><h3>移動した物</h3><p>${esc(r.moved_items || 'なし')}</p></div>
    <div class="detail-block"><h3>処分した物</h3><p>${esc(r.disposed_items || 'なし')}</p></div>
    <div class="detail-block">
      <h3>貴重品への接触 ${touched ? '<span class="badge warn">接触あり</span>' : '<span class="badge ok">接触なし</span>'}</h3>
      <p>${esc(VALUABLES_LABEL)}：${esc(r.valuables_touched)}</p>
      ${r.valuables_note ? `<p class="meta-text">内容：${esc(r.valuables_note)}</p>` : ''}
    </div>
    ${audioHtml}
    ${historyHtml}
    <p class="meta-text">
      記録作成日時：${esc(fmtISO(r.created_at))}（自動記録）<br>
      ${r.modified_at ? `最終修正日時：${esc(fmtISO(r.modified_at))}（自動記録）<br>` : ''}
      記録番号：${esc(r.id)}
    </p>`;
}

function openLightbox(url) {
  const box = document.createElement('div');
  box.className = 'lightbox';
  box.innerHTML = `<img src="${url}" alt="拡大写真">`;
  box.onclick = () => box.remove();
  document.body.appendChild(box);
}

function editCurrentRecord() {
  if (currentRecordId) showForm(currentRecordId);
}

// ─── 印刷（PDF出力）───
async function printRecord() {
  const raw = await dbGet('records', currentRecordId);
  if (!raw) return;
  const r = normalizeRecord(raw);
  const touched = r.valuables_touched === '触れた';

  let blockRows = '';
  for (let i = 0; i < r.work_blocks.length; i++) {
    const b = r.work_blocks[i];
    const label = r.work_blocks.length > 1 ? `作業${i + 1}：${b.location || '場所未記入'}` : `作業（${b.location || '場所未記入'}）`;
    blockRows += `<tr><th>${esc(label)}</th><td>${esc(b.content || '（未記入）')}</td></tr>`;
  }

  const photoFigs = async (b, blockLabel) => {
    let html = '';
    const sides = [['photos_before', '作業前'], ['photos_after', '作業後']];
    for (const [key, caption] of sides) {
      const fids = b[key] || [];
      for (let i = 0; i < fids.length; i++) {
        const f = await dbGet('files', fids[i]);
        if (f) {
          const url = trackUrl(URL.createObjectURL(f.blob));
          html += `<figure><img src="${url}"><figcaption>${esc(blockLabel)}・${caption} ${i + 1}</figcaption></figure>`;
        }
      }
    }
    return html;
  };

  let photosHtml = '';
  for (const b of r.work_blocks) {
    photosHtml += await photoFigs(b, b.location || '場所未記入');
  }

  document.getElementById('print-area').innerHTML = `
    <h1>訪問作業日報</h1>
    <table>
      <tr><th>訪問日時</th><td>${esc(fmtDateTime(r.visit_start))} 〜 ${esc(r.visit_end ? fmtDateTime(r.visit_end) : '')}</td></tr>
      ${blockRows}
      <tr><th>移動した物</th><td>${esc(r.moved_items || 'なし')}</td></tr>
      <tr><th>処分した物</th><td>${esc(r.disposed_items || 'なし')}</td></tr>
      <tr><th>貴重品への接触</th><td>${touched ? '接触あり' : '接触なし'}（${esc(VALUABLES_LABEL)}）${r.valuables_note ? '<br>内容：' + esc(r.valuables_note) : ''}</td></tr>
      <tr><th>音声記録</th><td>${r.audios?.length ? r.audios.map(a => esc(a.label)).join('、') + '（アプリ内に保存）' : 'なし'}</td></tr>
    </table>
    <div class="print-photos">${photosHtml}</div>
    <p class="print-meta">
      記録作成日時：${esc(fmtISO(r.created_at))}（自動記録）
      ${r.modified_at ? `／最終修正日時：${esc(fmtISO(r.modified_at))}（修正履歴${r.history?.length || 0}件をアプリ内に保存）` : '（修正なし）'}<br>
      記録番号：${esc(r.id)}
    </p>`;
  // 画像の読み込みを待ってから印刷
  const imgs = document.querySelectorAll('#print-area img');
  await Promise.all([...imgs].map(img => img.complete ? Promise.resolve() :
    new Promise(res => { img.onload = res; img.onerror = res; })));
  window.print();
}

// ─── LINE報告文 ───
async function buildShareText() {
  const r = normalizeRecord(await dbGet('records', currentRecordId));
  const touched = r.valuables_touched === '触れた';
  let photoTotalBefore = 0, photoTotalAfter = 0;
  const workLines = r.work_blocks.map(b => {
    photoTotalBefore += (b.photos_before || []).length;
    photoTotalAfter += (b.photos_after || []).length;
    return `・${b.location || '－'}：${b.content || '－'}`;
  });
  const lines = [
    '【作業報告】星さん宅🌟',
    `日時：${fmtDateTime(r.visit_start)}〜${r.visit_end ? fmtDateTime(r.visit_end).split(' ')[1] || '' : ''}`,
    '作業：',
    ...workLines,
  ];
  if (r.moved_items) lines.push(`移動した物：${r.moved_items}`);
  if (r.disposed_items) lines.push(`処分した物：${r.disposed_items}`);
  lines.push(touched
    ? `貴重品：触れました（${r.valuables_note || '詳細は日報参照'}）`
    : '貴重品（現金・通帳・印鑑・カードなど）：触れていません');
  lines.push(`写真：作業前${photoTotalBefore}枚・作業後${photoTotalAfter}枚（記録済み）`);
  return lines.join('\n');
}

async function showShareText() {
  document.getElementById('share-text').value = await buildShareText();
  document.getElementById('share-box').hidden = false;
  document.getElementById('share-box').scrollIntoView({ behavior: 'smooth' });
}

async function shareText() {
  const text = document.getElementById('share-text').value;
  if (navigator.share) {
    try { await navigator.share({ text }); } catch { /* キャンセル時は何もしない */ }
  } else {
    copyShareText();
  }
}

async function copyShareText() {
  const ta = document.getElementById('share-text');
  const status = document.getElementById('copy-status');
  try {
    await navigator.clipboard.writeText(ta.value);
    status.textContent = '✓ コピーしました。LINEに貼り付けてください。';
  } catch {
    ta.focus(); ta.select();
    status.textContent = '文章を長押しして「すべてを選択」→「コピー」してください。';
  }
}

// ─── 暗号化バックアップ ───
const BACKUP_MAGIC = new TextEncoder().encode('KKBK1');

async function deriveKey(password, salt) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 210000, hash: 'SHA-256' },
    keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result.split(',')[1]);
    fr.onerror = rej;
    fr.readAsDataURL(blob);
  });
}

function base64ToBlob(b64, type) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type });
}

async function exportBackup() {
  const pass = document.getElementById('backup-pass').value;
  const status = document.getElementById('backup-status');
  if (!pass || pass.length < 4) { alert('4文字以上のパスワードを入力してください。'); return; }
  status.textContent = '書き出し中…（写真が多いと時間がかかります）';
  try {
    const records = await dbGetAll('records');
    const filesRaw = await dbGetAll('files');
    const files = [];
    for (const f of filesRaw) {
      files.push({ fileId: f.fileId, type: f.type, data: await blobToBase64(f.blob) });
    }
    const payload = JSON.stringify({
      version: 1, exported_at: new Date().toISOString(), records, files,
    });
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(pass, salt);
    const cipher = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, key, new TextEncoder().encode(payload));
    const blob = new Blob([BACKUP_MAGIC, salt, iv, cipher], { type: 'application/octet-stream' });

    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const fname = `訪問記録バックアップ_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.kkbk`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    status.textContent = `✓ 書き出しました（${records.length}件、${(blob.size / 1024 / 1024).toFixed(1)}MB）。共有シートから「ファイルに保存」等でiCloudに保管してください。`;
    document.getElementById('backup-pass').value = '';
  } catch (err) {
    status.textContent = '';
    alert('書き出しに失敗しました：' + err.message);
  }
}

async function importBackup() {
  const fileInput = document.getElementById('restore-file');
  const pass = document.getElementById('restore-pass').value;
  const status = document.getElementById('restore-status');
  if (!fileInput.files.length) { alert('バックアップファイルを選択してください。'); return; }
  if (!pass) { alert('パスワードを入力してください。'); return; }
  if (!confirm('バックアップの内容を取り込みます。同じ記録番号のデータは上書きされます。よろしいですか？')) return;
  status.textContent = '復元中…';
  try {
    const buf = new Uint8Array(await fileInput.files[0].arrayBuffer());
    const magic = new TextDecoder().decode(buf.slice(0, 5));
    if (magic !== 'KKBK1') throw new Error('バックアップファイルの形式が違います。');
    const salt = buf.slice(5, 21);
    const iv = buf.slice(21, 33);
    const cipher = buf.slice(33);
    const key = await deriveKey(pass, salt);
    let plain;
    try {
      plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
    } catch {
      throw new Error('パスワードが違うか、ファイルが壊れています。');
    }
    const data = JSON.parse(new TextDecoder().decode(plain));
    for (const f of data.files || []) {
      await dbPut('files', { fileId: f.fileId, blob: base64ToBlob(f.data, f.type), type: f.type });
    }
    for (const r of data.records || []) {
      await dbPut('records', r);
    }
    status.textContent = `✓ ${data.records?.length || 0}件の記録を復元しました。`;
    document.getElementById('restore-pass').value = '';
    fileInput.value = '';
  } catch (err) {
    status.textContent = '';
    alert('復元に失敗しました：' + err.message);
  }
}

// ─── 初期化 ───
document.getElementById('f-audio-file').addEventListener('change', e => handleAudioFileInput(e.target));

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* file://等では失敗してよい */ });
}

showHome();
