(function(){
  /************** DOM **************/
  const $ = (id) => document.getElementById(id);
  const logEl      = $('log');
  const dropzone   = $('dropzone');
  const hiddenFile = $('hiddenFile');
  const btnPick    = $('btnPick');
  const btnPickOnce= $('btnPickOnce');
  const btnPause   = $('btnPause');
  const btnResume  = $('btnResume');
  const btnClear   = $('btnClear');
  const chkFollow  = $('chkFollow');
  const chkWrap    = $('chkWrap');
  const search     = $('search');
  const maxLinesEl = $('maxLines');
  const themeSel   = $('theme');

  const meta = {
    name: $('metaName'),
    size: $('metaSize'),
    pos:  $('metaPos'),
    status: $('metaStatus'),
    fs: $('metaFS')
  };
  const stats = { lines: $('statLines'), rate: $('statRate') };

  /************** Theme **************/
  const savedTheme = localStorage.getItem('wt_theme');
  if (savedTheme) { document.documentElement.setAttribute('data-theme', savedTheme); themeSel.value = savedTheme; }
  themeSel.addEventListener('change', () => {
    document.documentElement.setAttribute('data-theme', themeSel.value);
    localStorage.setItem('wt_theme', themeSel.value);
  });

  /************** Tail Reader **************/
  class TailReader {
    constructor(){
      this.handle = null;
      this.file   = null;
      this.offset = 0;
      this.timer  = null;
      this.paused = false;
      this.lastTickTime = 0;
      this.maxLines = parseInt(maxLinesEl.value,10);
      this.filter = null; // regex or null
      this.lines  = [];   // {text, ts}
      this.follow = true; // keep last line visible in log pane
    }

    setFilter(expr){ try{ this.filter = expr ? new RegExp(expr,'i') : null; } catch { this.filter = null; } this.renderAll(); }
    setMaxLines(n){ this.maxLines = Math.max(200, Math.min(200000, n|0)); this.trim(); this.renderAll(); }
    setFollow(v){ this.follow = !!v; }

    async openWithHandle(handle){
      this.reset();
      this.handle = handle;
      meta.fs.textContent = 'Persistent (File System Access)';
      meta.status.textContent = 'Opening…';
      const file = await this.handle.getFile();
      meta.name.textContent = file.name;
      await this.readTail(file, 100); // load last 100 lines
      this.offset = file.size;
      meta.size.textContent = fmtBytes(file.size);
      meta.pos.textContent  = fmtBytes(this.offset);
      this.start();
    }

    openOneShot(file){
      this.reset();
      this.file = file;
      meta.fs.textContent = 'One-time File (no live tail)';
      meta.status.textContent = 'Loading last 100…';
      this.readTail(file, 100).then(()=>{
        this.offset = file.size;
        meta.name.textContent = file.name;
        meta.size.textContent = fmtBytes(file.size);
        meta.pos.textContent  = fmtBytes(this.offset);
        meta.status.textContent = 'Loaded';
      });
    }

    async readTail(file, n){
      const CHUNK = 64 * 1024;
      let pos = file.size;
      let chunks = [];
      let newlines = 0;
      while (pos > 0 && newlines <= n){
        const start = Math.max(0, pos - CHUNK);
        const slice = await file.slice(start, pos).text();
        chunks.unshift(slice);
        newlines += (slice.match(/\r?\n/g) || []).length;
        pos = start;
        if (newlines > n + 5) break;
      }
      let text = chunks.join('');
      const lines = text.replace(/\r\n/g, '\n').split('\n');
      const tail = lines.slice(Math.max(0, lines.length - n));
      for (const l of tail){
        this.lines.push({ text: l, ts: nowTS() });
      }
      this.trim();
      this.renderAll();
      meta.status.textContent = 'Ready';
    }

    reset(){
      this.stop();
      this.handle = null; this.file = null; this.offset = 0; this.lines = [];
      logEl.innerHTML = '';
      meta.name.textContent = '—'; meta.size.textContent = '—'; meta.pos.textContent = '—';
      meta.status.textContent = 'Idle'; stats.rate.textContent = '0 B/s'; stats.lines.textContent = '0 lines';
      btnClear.disabled = true; btnPause.disabled = true; btnResume.disabled = true;
    }

    start(){
      this.paused = false; btnPause.disabled = false; btnResume.disabled = true; btnClear.disabled = false;
      this.timer = setInterval(()=>this.tick(), 500);
      meta.status.textContent = 'Tailing…';
    }

    stop(){ if (this.timer) { clearInterval(this.timer); this.timer = null; } btnPause.disabled = true; btnResume.disabled = true; }
    pause(){ this.paused = true;  btnPause.disabled = true;  btnResume.disabled = false; meta.status.textContent = 'Paused'; }
    resume(){ this.paused = false; btnPause.disabled = false; btnResume.disabled = true;  meta.status.textContent = 'Tailing…'; }

    async tick(){
      if (this.paused) return;
      let file;
      try {
        if (this.handle) file = await this.handle.getFile();
        else if (this.file) file = this.file;
        else return;
      } catch {
        meta.status.textContent = 'Permission denied or file unavailable'; return;
      }

      meta.size.textContent = fmtBytes(file.size);

      if (file.size < this.offset) { // rotation
        this.offset = 0;
        this._pushSystemLine('[log rotated or truncated → restarting from 0]');
      }

      if (file.size > this.offset) {
        const chunk = await file.slice(this.offset, file.size).text();
        this.offset = file.size;
        meta.pos.textContent = fmtBytes(this.offset);

        const now = performance.now();
        const bytes = chunk.length;
        if (this.lastTickTime) {
          const rate = bytes / ((now - this.lastTickTime)/1000);
          stats.rate.textContent = fmtBytes(rate) + '/s';
        }
        this.lastTickTime = now;

        this.consume(chunk);
      } else {
        meta.pos.textContent = fmtBytes(this.offset);
      }
    }

    consume(text){
      if (!text) return;
      const endsWithNewline = /\r?\n$/.test(text);
      const parts = text.split(/\r?\n/);
      const added = [];
      for (let i=0;i<parts.length;i++){
        const isLast = i === parts.length-1;
        const chunkLine = parts[i];
        if (isLast && !endsWithNewline) {
          if (this.lines.length) { this.lines[this.lines.length-1].text += chunkLine; added.push({merge:true}); }
          else { const obj = { text: chunkLine, ts: nowTS() }; this.lines.push(obj); added.push(obj); }
        } else {
          if (!(isLast && endsWithNewline && chunkLine === '')) {
            const obj = { text: chunkLine, ts: nowTS() };
            this.lines.push(obj); added.push(obj);
          }
        }
      }
      this.trim();
      this.renderAppend(added.filter(x=>!x.merge));
    }

    trim(){ const extra = this.lines.length - this.maxLines; if (extra > 0) this.lines.splice(0, extra); stats.lines.textContent = `${this.lines.length} lines`; }

    renderAll(){ logEl.innerHTML = ''; this.renderAppend(this.lines, true); }

    renderAppend(items, full=false){
      const filter = this.filter;
      const wrap = chkWrap.checked;
      if (full) logEl.innerHTML = '';

      let count = full ? 0 : logEl.childElementCount;
      const created = [];
      for (const rec of items){
        const line = rec.text ?? '';
        if (filter && !filter.test(line)) continue;

        const div = document.createElement('div');
        div.className = 'line' + (full ? '' : ' flash'); // flash on new lines
        div.style.whiteSpace = wrap ? 'pre-wrap' : 'pre';

        const ts = document.createElement('span'); ts.className = 'ts'; ts.textContent = rec.ts;
        const ln = document.createElement('span'); ln.className = 'ln'; ln.textContent = String(++count).padStart(6,' ');
        const content = document.createElement('span'); content.className = 'content'; content.appendChild(highlight(line, filter));

        if (/\b(error|fail|exception)\b/i.test(line)) div.style.borderLeftColor = 'var(--bad)';
        else if (/\b(warn|timeout|retry)\b/i.test(line)) div.style.borderLeftColor = 'var(--warn)';
        else if (/\b(started|listening|ready|success)\b/i.test(line)) div.style.borderLeftColor = 'var(--good)';

        div.append(ts, ln, content);
        logEl.appendChild(div);
        if (!full) created.push(div);
      }
      // Remove flash class after 2s
      setTimeout(()=> created.forEach(el => el.classList.remove('flash')), 2100);
      if (this.follow) logEl.scrollTop = logEl.scrollHeight;
    }

    _pushSystemLine(msg){ const obj = { text: msg, ts: nowTS() }; this.lines.push(obj); this.renderAppend([obj]); }
  }

  /************** Helpers **************/
  function nowTS(){
    const d = new Date();
    return d.toLocaleTimeString([], { hour12:false, hour:'2-digit', minute:'2-digit', second:'2-digit' });
  }
  function fmtBytes(x){
    if (!isFinite(x)) return '—';
    const units=['B','KB','MB','GB','TB'];
    let i=0; while (x>=1024 && i<units.length-1){ x/=1024; i++; }
    return (i===0?Math.round(x):x.toFixed(1)) + ' ' + units[i];
  }
  function highlight(text, filter){
    if (!filter) return document.createTextNode(text);
    const frag = document.createDocumentFragment();
    let lastIndex = 0; let m; const s = text;
    const re = new RegExp(filter.source, filter.flags.replace('g','') + 'g');
    while ((m = re.exec(s))){
      if (m.index > lastIndex) frag.appendChild(document.createTextNode(s.slice(lastIndex, m.index)));
      const span = document.createElement('span'); span.className = 'highlight'; span.textContent = m[0]; frag.appendChild(span);
      lastIndex = m.index + m[0].length;
    }
    if (lastIndex < s.length) frag.appendChild(document.createTextNode(s.slice(lastIndex)));
    return frag;
  }

  /************** Wire up UI **************/
  const reader = new TailReader();
  maxLinesEl.addEventListener('change', ()=> reader.setMaxLines(parseInt(maxLinesEl.value,10)));
  chkFollow.addEventListener('change', ()=> reader.setFollow(chkFollow.checked));
  chkWrap.addEventListener('change', ()=> reader.renderAll());
  search.addEventListener('input', ()=> reader.setFilter(search.value.trim()));
  btnPause.addEventListener('click', ()=> reader.pause());
  btnResume.addEventListener('click', ()=> reader.resume());
  btnClear.addEventListener('click', ()=> { reader.lines=[]; reader.renderAll(); });

  // File openers
  btnPick.addEventListener('click', async ()=>{
    try { const [handle] = await window.showOpenFilePicker({ multiple:false, excludeAcceptAllOption:false }); await reader.openWithHandle(handle); } catch(e) {}
  });
  btnPickOnce.addEventListener('click', ()=> hiddenFile.click());
  hiddenFile.addEventListener('change', ()=>{
    const f = hiddenFile.files && hiddenFile.files[0];
    if (f) reader.openOneShot(f);
    hiddenFile.value = '';
  });

  const supportFS = 'showOpenFilePicker' in window;
  meta.fs.textContent = supportFS ? 'Available' : 'Limited (use Quick Open)';
  ['dragenter','dragover'].forEach(ev=> dropzone.addEventListener(ev, (e)=>{ e.preventDefault(); dropzone.style.background='rgba(122,162,255,.16)'; dropzone.style.borderColor='var(--accent)'; dropzone.style.boxShadow='0 0 0 3px var(--ring)'; }));
  ['dragleave','drop'].forEach(ev=> dropzone.addEventListener(ev, (e)=>{ e.preventDefault(); dropzone.style.background=''; dropzone.style.borderColor='var(--border)'; dropzone.style.boxShadow='none'; }));

  dropzone.addEventListener('drop', async (e)=>{
    const dt = e.dataTransfer;
    if (dt && dt.items && dt.items[0] && dt.items[0].getAsFileSystemHandle) {
      const handle = await dt.items[0].getAsFileSystemHandle();
      if (handle && handle.kind === 'file') { await reader.openWithHandle(handle); return; }
    }
    if (dt && dt.files && dt.files[0]) { reader.openOneShot(dt.files[0]); }
  });

  dropzone.addEventListener('click', async ()=>{
    if (supportFS) {
      try { const [handle] = await window.showOpenFilePicker({ multiple:false }); await reader.openWithHandle(handle); } catch(e){}
    } else {
      hiddenFile.click();
    }
  });

  // Warn on file://
  if (!isSecureContext) {
    const warn = document.createElement('div');
    warn.style.cssText = "position:fixed;left:10px;bottom:10px;background:#3a2f1b;color:#ffd27a;padding:8px 12px;border-radius:10px;border:1px solid #5f4a29;box-shadow:var(--shadow);z-index:9999;font:12px system-ui";
    warn.textContent = "Opened via file:// — use http://localhost for live tail & to avoid extension errors.";
    document.body.appendChild(warn);
    setTimeout(()=> warn.remove(), 8000);
  }
})();
// ===== Consent + Google AdSense loader =====
(function(){
  const CONSENT_KEY = 'wt_ads_consent'; // 'personalized' | 'nonpersonalized'
  const banner = document.getElementById('consent');
  const btnYes = document.getElementById('btnConsentPersonalized');
  const btnNo  = document.getElementById('btnConsentNonPersonalized');
  const slot   = document.getElementById('adLeftSlot');

  function showBanner(){ if (banner) banner.style.display = 'block'; }
  function hideBanner(){ if (banner) banner.style.display = 'none'; }

  function loadAdSense(mode){
    if (!slot) return;
    if (document.querySelector('script[data-adsbygoogle-loaded]')) {
      renderSlot(mode);
      return;
    }
    const s = document.createElement('script');
    // Replace with your real publisher ID
    s.src = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-XXXXXXXXXXXXXXX";
    s.async = true;
    s.crossOrigin = "anonymous";
    s.setAttribute('data-adsbygoogle-loaded', '1');
    s.onload = () => renderSlot(mode);
    document.head.appendChild(s);
  }

  function renderSlot(mode){
    try {
      window.adsbygoogle = window.adsbygoogle || [];
      if (mode === 'nonpersonalized') {
        window.adsbygoogle.requestNonPersonalizedAds = 1;
      }
      if (!slot.dataset.loaded) {
        (adsbygoogle = window.adsbygoogle).push({});
        slot.dataset.loaded = '1';
        const fb = document.querySelector('#adLeft .adfallback'); if (fb) fb.style.display = 'none';
      }
    } catch (e) {
      console.warn('Ads render error', e);
    }
  }

  const saved = localStorage.getItem(CONSENT_KEY);
  if (saved === 'personalized' || saved === 'nonpersonalized') {
    hideBanner();
    loadAdSense(saved);
  } else {
    showBanner();
  }

  if (btnYes) btnYes.addEventListener('click', () => {
    localStorage.setItem(CONSENT_KEY, 'personalized');
    hideBanner();
    loadAdSense('personalized');
  });
  if (btnNo) btnNo.addEventListener('click', () => {
    localStorage.setItem(CONSENT_KEY, 'nonpersonalized');
    hideBanner();
    loadAdSense('nonpersonalized');
  });
})();
