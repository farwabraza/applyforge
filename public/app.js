/* ApplyForge client — all modules. State lives in localStorage (privacy: docs never stored server-side). */

/* ================= CONFIG (junior: edit these lines — see SETUP-GUIDE Part 3) ================= */
const CHECKOUT_URL = "https://YOURSTORE.lemonsqueezy.com/checkout/buy/YOUR-PRODUCT-ID"; // ← Lemon Squeezy checkout link
const SUPABASE_URL = "https://YOURPROJECT.supabase.co";   // ← Supabase → Settings → API
const SUPABASE_ANON_KEY = "YOUR-ANON-PUBLIC-KEY";          // ← anon/public key (safe to expose)
const TRIAL_DAYS = 3;

/* Accounts: Supabase handles login; each user gets one private row (profile, tracker, answers,
   license, trial start) protected by row-level security. If config above is untouched, the app
   runs in local-only mode so you can test before wiring accounts. */
const CLOUD = !SUPABASE_URL.includes("YOURPROJECT");
const sb = CLOUD ? supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
let session = null;

/* ================= State ================= */
const S = {
  get profile() { return JSON.parse(localStorage.getItem("af_profile") || "null"); },
  set profile(v) { localStorage.setItem("af_profile", JSON.stringify(v)); cloudSave(); },
  get voice() { return localStorage.getItem("af_voice") || ""; },
  set voice(v) { localStorage.setItem("af_voice", v); cloudSave(); },
  get apps() { return JSON.parse(localStorage.getItem("af_apps") || "[]"); },
  set apps(v) { localStorage.setItem("af_apps", JSON.stringify(v)); cloudSave(); },
  get answers() { return JSON.parse(localStorage.getItem("af_answers") || "[]"); },
  set answers(v) { localStorage.setItem("af_answers", JSON.stringify(v)); cloudSave(); },
};
if (!localStorage.getItem("af_trialStart")) localStorage.setItem("af_trialStart", Date.now());
const trialDaysLeft = () => Math.max(0, TRIAL_DAYS - Math.floor((Date.now() - +localStorage.getItem("af_trialStart")) / 86400000));
const isPro = () => localStorage.getItem("af_license_valid") === "1";
const hasAccess = () => isPro() || trialDaysLeft() > 0;

/* ---------- Cloud sync (Supabase) ---------- */
let saveTimer = null;
function cloudSave() {
  if (!CLOUD || !session) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await sb.from("user_data").upsert({
      user_id: session.user.id,
      profile: S.profile, voice: S.voice, apps: S.apps, answers: S.answers,
      license_key: localStorage.getItem("af_license_key") || null,
      updated_at: new Date().toISOString(),
    });
  }, 800);
}
async function cloudLoad() {
  const { data: row } = await sb.from("user_data").select("*").eq("user_id", session.user.id).maybeSingle();
  if (!row) {
    // First login on this account: adopt any local data, anchor the trial to the ACCOUNT
    const trialStart = new Date().toISOString();
    await sb.from("user_data").insert({
      user_id: session.user.id, profile: S.profile, voice: S.voice, apps: S.apps, answers: S.answers,
      trial_start: trialStart,
    });
    localStorage.setItem("af_trialStart", Date.parse(trialStart));
    return;
  }
  if (row.profile) localStorage.setItem("af_profile", JSON.stringify(row.profile));
  localStorage.setItem("af_voice", row.voice || "");
  localStorage.setItem("af_apps", JSON.stringify(row.apps || []));
  localStorage.setItem("af_answers", JSON.stringify(row.answers || []));
  localStorage.setItem("af_trialStart", Date.parse(row.trial_start));
  if (row.license_key) {
    localStorage.setItem("af_license_key", row.license_key);
    try { const d = await api("/api/license", { key: row.license_key });
      localStorage.setItem("af_license_valid", d.valid ? "1" : "0");
    } catch { /* keep last known state */ }
  } else localStorage.removeItem("af_license_valid");
}

/* ================= Utilities ================= */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const toast = (m) => { const t = $("#toast"); t.textContent = m; t.classList.remove("hidden"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.add("hidden"), 3200); };
const profileText = () => { const p = S.profile; return p ? JSON.stringify(p) : ""; };

async function api(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || "Request failed");
  return d;
}
async function generate(task, payload) {
  if (!hasAccess()) { showPaywall(); throw new Error("locked"); }
  const d = await api("/api/generate", { task, payload });
  return d.text;
}
const parseJson = (t) => JSON.parse(t.replace(/```json|```/g, "").slice(t.indexOf("{") === -1 ? 0 : t.replace(/```json|```/g, "").indexOf("{")).trim().replace(/^[^{]*/, "").replace(/[^}]*$/, ""));
function safeJson(t) {
  const c = t.replace(/```json|```/g, "").trim();
  return JSON.parse(c.slice(c.indexOf("{"), c.lastIndexOf("}") + 1));
}

/* ---------- File reading: PDF & DOCX read directly, never dumped into a textbox ---------- */
if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
async function readFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf")) {
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    let out = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      out += tc.items.map((it) => it.str).join(" ") + "\n";
    }
    if (out.trim().length < 60) throw new Error("This PDF looks scanned (image-only). Export a text PDF or upload the Word version.");
    return out;
  }
  if (name.endsWith(".docx")) {
    const buf = await file.arrayBuffer();
    const { value } = await mammoth.extractRawText({ arrayBuffer: buf });
    return value;
  }
  if (name.endsWith(".txt")) return await file.text();
  throw new Error("Use PDF, DOCX, or TXT.");
}

/* ================= Trial badge & paywall ================= */
function renderBadge() {
  const b = $("#trialBadge");
  if (isPro()) { b.textContent = "PRO"; b.style.color = "var(--good)"; }
  else if (trialDaysLeft() > 0) b.textContent = `Trial · ${trialDaysLeft()}d left`;
  else { b.textContent = "Trial ended"; }
}
function showPaywall() { $("#paywall").classList.remove("hidden"); $("#checkoutLink").href = CHECKOUT_URL; }
$("#licenseBtn").onclick = async () => {
  const key = $("#licenseInput").value.trim();
  if (!key) return;
  $("#licenseMsg").textContent = "Checking…";
  try {
    const d = await api("/api/license", { key });
    if (d.valid) { localStorage.setItem("af_license_valid", "1"); localStorage.setItem("af_license_key", key); cloudSave(); $("#paywall").classList.add("hidden"); renderBadge(); toast("Welcome to Pro. Everything is unlocked — on every device you log into."); }
    else $("#licenseMsg").textContent = "That key isn't valid or is inactive.";
  } catch { $("#licenseMsg").textContent = "Check failed — retry."; }
};
$("#paywall").addEventListener("click", (e) => { if (e.target.id === "paywall" && hasAccess()) $("#paywall").classList.add("hidden"); });

/* ================= Profile drawer ================= */
const drawer = $("#drawer");
$("#profileBtn").onclick = () => { drawer.classList.remove("hidden"); renderProfile(); };
$("#drawerClose").onclick = () => drawer.classList.add("hidden");
const dz = $("#profileDrop"), pf = $("#profileFile");
dz.onclick = () => pf.click();
["dragover", "dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.toggle("over", ev === "dragover"); }));
dz.addEventListener("drop", (e) => e.dataTransfer.files[0] && ingestProfile(e.dataTransfer.files[0]));
pf.onchange = () => pf.files[0] && ingestProfile(pf.files[0]);

async function ingestProfile(file) {
  const st = $("#profileStatus");
  try {
    st.textContent = `Reading ${file.name}…`;
    const text = await readFile(file);
    st.textContent = "Structuring your profile…";
    const out = await generate("parse_profile", { cvText: text.slice(0, 15000) });
    S.profile = safeJson(out);
    st.textContent = "";
    renderProfile(); renderBadge();
    toast("Profile saved. Every tool now knows you.");
  } catch (e) { st.textContent = ""; toast(e.message === "locked" ? "Trial ended — unlock to continue." : e.message); }
}
function renderProfile() {
  const p = S.profile, v = $("#profileView");
  $("#voiceSample").value = S.voice;
  $("#profileEdit").classList.toggle("hidden", !p);
  $("#profileClear").classList.toggle("hidden", !p);
  if (!p) { v.innerHTML = `<p class="muted">No profile yet.</p>`; return; }
  v.innerHTML = `<div class="qa"><h4>${esc(p.name || "Unnamed")} — ${esc(p.title || "")}</h4>
    <p>${esc(p.summary || "")}</p>
    <p class="small" style="margin-top:8px">${(p.experience || []).length} roles · ${(p.education || []).length} education entries · ${(p.skills?.core || []).length + (p.skills?.tools || []).length} skills</p></div>`;
}
$("#profileEdit").onclick = () => { $("#profileJson").value = JSON.stringify(S.profile, null, 2); $("#profileJson").classList.remove("hidden"); $("#profileSave").classList.remove("hidden"); };
$("#profileSave").onclick = () => { try { S.profile = JSON.parse($("#profileJson").value); $("#profileJson").classList.add("hidden"); $("#profileSave").classList.add("hidden"); renderProfile(); toast("Profile updated."); } catch { toast("That JSON has a syntax error."); } };
$("#profileClear").onclick = () => { if (confirm("Delete your saved profile?")) { localStorage.removeItem("af_profile"); renderProfile(); } };
$("#voiceSave").onclick = () => { S.voice = $("#voiceSample").value; toast("Voice sample saved."); };

/* ================= Shared components ================= */
function jobInputHTML(id) {
  return `<div class="panel"><div class="panel-head"><span>The Job / Gig Posting</span>
    <div class="row gap"><input type="text" id="${id}Url" placeholder="…or paste a posting URL" style="max-width:230px;font-size:12px;padding:6px 10px">
    <button class="ghost mini" id="${id}Fetch">Fetch</button></div></div>
    <textarea id="${id}Text" placeholder="Paste the full posting here — requirements, responsibilities, everything."></textarea></div>`;
}
function wireJobFetch(id) {
  $(`#${id}Fetch`).onclick = async () => {
    const url = $(`#${id}Url`).value.trim(); if (!url) return;
    $(`#${id}Fetch`).textContent = "…";
    try { const d = await api("/api/fetch-job", { url }); $(`#${id}Text`).value = d.text; toast("Posting fetched."); }
    catch (e) { toast(e.message); }
    $(`#${id}Fetch`).textContent = "Fetch";
  };
}
function cvSourceHTML(id) {
  const p = S.profile;
  return `<div class="panel"><div class="panel-head"><span>Your CV</span>
    <button class="ghost mini" id="${id}Up">Upload PDF/DOCX</button><input type="file" id="${id}File" accept=".pdf,.docx,.txt" hidden></div>
    <div style="padding:14px" id="${id}State">${p ? `<div class="filechip">✓ Using saved profile: ${esc(p.name || "profile")}</div><p class="small muted" style="margin-top:8px">Upload a different file to override for this run.</p>` : `<p class="small muted">No saved profile — upload your CV or your LinkedIn export (profile → More → Save to PDF). Read directly, nothing to paste. Or set it once in My Profile.</p>`}</div></div>`;
}
function wireCvSource(id, store) {
  store.cv = S.profile ? profileText() : "";
  $(`#${id}Up`).onclick = () => $(`#${id}File`).click();
  $(`#${id}File`).onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { $(`#${id}State`).innerHTML = `<p class="small muted">Reading ${esc(f.name)}…</p>`;
      store.cv = await readFile(f);
      $(`#${id}State`).innerHTML = `<div class="filechip">✓ ${esc(f.name)} — read directly</div>`;
    } catch (err) { $(`#${id}State`).innerHTML = `<p class="small muted">${esc(err.message)}</p>`; }
  };
}
const loadingHTML = (msg) => `<div class="loading"><div class="pulse serif">${msg}</div><small>ApplyForge is working</small></div>`;

/* ---------- CV document renderer + print ---------- */
function renderCvDoc(cv) {
  const skills = cv.skills || {};
  const skillLine = (arr) => (arr || []).map(esc).join(" · ");
  return `<div class="cvdoc" id="cvdoc">
    <h1>${esc(cv.name)}</h1>
    <div class="cv-title">${esc(cv.title || "")}</div>
    <div class="cv-contact">${[cv.contact?.email, cv.contact?.phone, cv.contact?.location, ...(cv.contact?.links || [])].filter(Boolean).map(esc).join("  ·  ")}</div>
    ${cv.summary ? `<h3>Profile</h3><p>${esc(cv.summary)}</p>` : ""}
    ${(cv.experience || []).length ? `<h3>Experience</h3>` + cv.experience.map((x) => `<div class="xp"><div class="xp-head"><b>${esc(x.role)} — ${esc(x.company)}</b><span>${esc(x.dates || "")}</span></div><ul>${(x.bullets || []).map((b) => `<li>${esc(b)}</li>`).join("")}</ul></div>`).join("") : ""}
    ${(cv.education || []).length ? `<h3>Education</h3>` + cv.education.map((e) => `<div class="xp"><div class="xp-head"><b>${esc(e.degree)} — ${esc(e.school)}</b><span>${esc(e.dates || "")}</span></div>${e.note ? `<p class="small muted">${esc(e.note)}</p>` : ""}</div>`).join("") : ""}
    ${(skills.core?.length || skills.tools?.length || skills.languages?.length) ? `<h3>Skills</h3><p class="skills-line">${skills.core?.length ? `<b>Core:</b> ${skillLine(skills.core)}<br>` : ""}${skills.tools?.length ? `<b>Tools:</b> ${skillLine(skills.tools)}<br>` : ""}${skills.languages?.length ? `<b>Languages:</b> ${skillLine(skills.languages)}` : ""}</p>` : ""}
    ${(cv.extras || []).map((ex) => `<h3>${esc(ex.heading)}</h3><ul>${(ex.items || []).map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`).join("")}
  </div>
  <div class="tpl-toggle noprint">
    <button class="ghost mini on" id="tplDesign">Designed</button>
    <button class="ghost mini" id="tplAts">ATS-safe</button>
    <span class="small muted" style="align-self:center">ATS-safe = single column, standard headings &amp; fonts — what recruiter software parses cleanly.</span>
  </div>
  <div class="runbar noprint" style="justify-content:center">
    <button class="cta" onclick="window.print()">Download as PDF</button>
    <button class="ghost" id="cvCopy">Copy as text</button>
    <button class="ghost" id="cvTrack">＋ Add to Tracker</button>
  </div>`;
}
function wireCvDocActions(cv, jobMeta) {
  const doc = $("#cvdoc"), bD = $("#tplDesign"), bA = $("#tplAts");
  const setTpl = (ats) => { doc.classList.toggle("ats", ats); bA.classList.toggle("on", ats); bD.classList.toggle("on", !ats);
    bA.style = ats ? "background:var(--ink);color:var(--paper)" : ""; bD.style = !ats ? "background:var(--ink);color:var(--paper)" : ""; };
  bD.onclick = () => setTpl(false); bA.onclick = () => setTpl(true);
  setTpl(true); // ATS-safe by default — the version that survives the robots
  $("#cvCopy").onclick = () => {
    const t = [cv.name, cv.title, cv.summary, ...(cv.experience || []).map((x) => `${x.role} — ${x.company} (${x.dates})\n${(x.bullets || []).map((b) => "• " + b).join("\n")}`)].join("\n\n");
    navigator.clipboard.writeText(t); toast("Copied.");
  };
  $("#cvTrack").onclick = () => { addToTracker(jobMeta); toast("Added to tracker."); };
}
function addToTracker(meta = {}) {
  const apps = S.apps;
  apps.unshift({ id: Date.now(), role: meta.role || "Untitled role", company: meta.company || "—", status: "applied", date: new Date().toISOString().slice(0, 10), followUp: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10), notes: meta.notes || "" });
  S.apps = apps;
}

/* ================= Views ================= */
const app = $("#app");
const views = {

  /* ---------- Tracker ---------- */
  tracker() {
    const apps = S.apps;
    const stages = [["applied", "Applied"], ["interview", "Interview"], ["offer", "Offer"], ["rejected", "Closed"]];
    const today = new Date().toISOString().slice(0, 10);
    const counts = Object.fromEntries(stages.map(([k]) => [k, apps.filter((a) => a.status === k).length]));
    app.innerHTML = `
      <h1 class="page">Your applications, <em>under control.</em></h1>
      <p class="lede">Every application, its CV version, and when to follow up — nothing slips.</p>
      <div class="row gap" style="flex-wrap:wrap">
        <input type="text" id="tRole" placeholder="Role title" style="max-width:220px">
        <input type="text" id="tCo" placeholder="Company / client" style="max-width:200px">
        <button class="cta" id="tAdd" style="padding:11px 20px">＋ Track application</button>
      </div>
      <div class="statline">
        <div class="stat"><b>${apps.length}</b><span>Total</span></div>
        <div class="stat"><b>${counts.interview}</b><span>Interviews</span></div>
        <div class="stat"><b>${counts.offer}</b><span>Offers</span></div>
        <div class="stat"><b>${apps.filter((a) => a.followUp && a.followUp <= today && a.status === "applied").length}</b><span>Follow-ups due</span></div>
      </div>
      <div class="pipeline">${stages.map(([k, label]) => `
        <div class="col"><h4>${label}<span>${counts[k]}</span></h4>
        ${apps.filter((a) => a.status === k).map((a) => `
          <div class="appcard"><b>${esc(a.role)}</b><span class="co">${esc(a.company)} · ${esc(a.date)}</span>
          ${a.followUp && a.status === "applied" ? `<div class="due ${a.followUp <= today ? "overdue" : ""}">Follow up ${a.followUp <= today ? "NOW" : esc(a.followUp)}</div>` : ""}
          <div class="acts">
            ${stages.filter(([s]) => s !== k).map(([s, l]) => `<button class="ghost mini" data-move="${a.id}:${s}">${l}</button>`).join("")}
            <button class="ghost mini danger" data-del="${a.id}">✕</button>
          </div></div>`).join("")}</div>`).join("")}
      </div>`;
    $("#tAdd").onclick = () => { const r = $("#tRole").value.trim(); if (!r) return; addToTracker({ role: r, company: $("#tCo").value.trim() }); views.tracker(); };
    app.querySelectorAll("[data-move]").forEach((b) => b.onclick = () => { const [id, s] = b.dataset.move.split(":"); const apps = S.apps; const a = apps.find((x) => x.id == id); a.status = s; S.apps = apps; views.tracker(); });
    app.querySelectorAll("[data-del]").forEach((b) => b.onclick = () => { S.apps = S.apps.filter((x) => x.id != b.dataset.del); views.tracker(); });
  },

  /* ---------- Gap Report ---------- */
  gap() {
    const st = { cv: "" };
    app.innerHTML = `
      <h1 class="page">Every rejection has a reason.<br><em>See yours before they do.</em></h1>
      <p class="lede">An honest diagnosis: what matches, what's buried, what's missing — and the fastest way to fix it.</p>
      <div class="panels">${cvSourceHTML("g")}${jobInputHTML("g")}</div>
      <div class="runbar"><button class="cta" id="gRun">Run Gap Report →</button></div>
      <div id="gOut"></div>`;
    wireCvSource("g", st); wireJobFetch("g");
    $("#gRun").onclick = async () => {
      const job = $("#gText").value.trim();
      if (!st.cv || job.length < 80) return toast("Need both your CV and a full posting.");
      $("#gOut").innerHTML = loadingHTML("Reading between the lines…");
      try {
        const r = safeJson(await generate("gap_report", { cvText: st.cv, jobText: job }));
        const sev = (s) => s === "critical" ? "var(--accent)" : s === "moderate" ? "var(--amber)" : "var(--ink-soft)";
        const sc = r.fitScore >= 75 ? "var(--good)" : r.fitScore >= 50 ? "var(--amber)" : "var(--accent)";
        const C = 2 * Math.PI * 74;
        $("#gOut").innerHTML = `<div class="reveal">
          <div class="verdict"><svg width="180" height="180" viewBox="0 0 180 180">
            <circle cx="90" cy="90" r="74" fill="none" stroke="rgba(247,243,235,.15)" stroke-width="10"/>
            <circle cx="90" cy="90" r="74" fill="none" stroke="${sc}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C - (r.fitScore / 100) * C}" transform="rotate(-90 90 90)"/>
            <text x="90" y="86" text-anchor="middle" fill="#F7F3EB" font-size="44" font-family="'Instrument Serif',serif">${r.fitScore}</text>
            <text x="90" y="112" text-anchor="middle" fill="#A9A292" font-size="10" letter-spacing="2">FIT SCORE</text></svg>
          <div><h2>${esc(r.scoreLabel)}</h2><p>${esc(r.verdict)}</p></div></div>
          ${sectionHTML("I.", "What's working for you", r.strengths, (s) => `<div class="item"><div class="dot" style="background:var(--good)"></div><div><h4>${esc(s.title)}</h4><p>${esc(s.note)}</p></div></div>`)}
          ${sectionHTML("II.", "Buried treasure — you have it, they can't see it", r.buried, (b) => `<div class="item"><div class="dot" style="background:var(--amber)"></div><div><h4>${esc(b.title)}</h4><p><b>Surface it:</b> ${esc(b.fix)}</p></div></div>`)}
          ${sectionHTML("III.", "The gaps — and how to close them", r.gaps, (g) => `<div class="item"><div class="dot" style="background:${sev(g.severity)}"></div><div><h4>${esc(g.title)}<span class="sev" style="color:${sev(g.severity)};border-color:${sev(g.severity)}">${esc(g.severity)}</span></h4><p><b>Close it:</b> ${esc(g.fix)}</p></div></div>`)}
          <div class="sec"><div class="sec-head"><span class="sec-num">IV.</span><span class="sec-title">Keyword radar</span></div>
            <p class="small" style="letter-spacing:1.5px;text-transform:uppercase;color:var(--good);margin:6px 0 8px">In your CV</p>
            <div class="chips">${(r.keywords?.matched || []).map((k) => `<span class="chip" style="border-color:var(--good);color:var(--good)">${esc(k)}</span>`).join("")}</div>
            <p class="small" style="letter-spacing:1.5px;text-transform:uppercase;color:var(--accent);margin:16px 0 8px">Missing — ATS won't find these</p>
            <div class="chips">${(r.keywords?.missing || []).map((k) => `<span class="chip" style="border-color:var(--accent);color:var(--accent)">${esc(k)}</span>`).join("")}</div></div>
          <div class="onemove"><h3>If you do one thing…</h3><p>${esc(r.oneMove)}</p></div>
          <div class="runbar noprint"><button class="ghost" id="gTrack">＋ Add to Tracker</button></div>
        </div>`;
        $("#gTrack").onclick = () => { addToTracker({ role: "From Gap Report", notes: r.oneMove }); toast("Tracked."); };
      } catch (e) { $("#gOut").innerHTML = e.message === "locked" ? "" : `<div class="err">${esc(e.message)} — hit Run again.</div>`; }
    };
  },

  /* ---------- Tailor CV ---------- */
  tailor() {
    const st = { cv: "" };
    app.innerHTML = `
      <h1 class="page">One profile. <em>A CV for every door.</em></h1>
      <p class="lede">Reordered, reworded, keyword-matched — using only what's true about you. Output is a real formatted document, not a wall of text.</p>
      <div class="panels">${cvSourceHTML("t")}${jobInputHTML("t")}</div>
      <textarea id="tNotes" rows="2" placeholder="Optional notes: anything to emphasise or leave out for this application…" style="margin-top:14px"></textarea>
      <div class="runbar"><button class="cta" id="tRun">Forge my tailored CV →</button></div>
      <div id="tOut"></div>`;
    wireCvSource("t", st); wireJobFetch("t");
    $("#tRun").onclick = async () => {
      const job = $("#tText").value.trim();
      if (!st.cv || job.length < 80) return toast("Need both your CV and a full posting.");
      $("#tOut").innerHTML = loadingHTML("Forging your CV…");
      try {
        const cv = safeJson(await generate("tailor_cv", { cvText: st.cv, jobText: job, notes: $("#tNotes").value }));
        $("#tOut").innerHTML = renderCvDoc(cv);
        wireCvDocActions(cv, { role: cv.title || "Tailored CV", company: (job.match(/at ([A-Z][\w& ]{2,30})/) || [])[1] || "—" });
      } catch (e) { $("#tOut").innerHTML = e.message === "locked" ? "" : `<div class="err">${esc(e.message)} — retry.</div>`; }
    };
  },

  /* ---------- CV Builder (from scratch) ---------- */
  builder() {
    app.innerHTML = `
      <h1 class="page">No CV yet? <em>Start from zero.</em></h1>
      <p class="lede">Answer in plain words — messy is fine. ApplyForge structures it into a professional document and saves it as your profile.</p>
      <div class="panel"><div class="panel-head"><span>Tell me about yourself</span></div>
      <textarea id="bIntake" style="min-height:280px" placeholder="Write freely, cover what you can:
• Name, city, email, phone
• Jobs you've had — where, when, what you actually did and achieved
• Education, courses, certificates
• Skills, tools, software, languages you speak
• Projects, volunteering, anything you're proud of"></textarea></div>
      <input type="text" id="bTarget" placeholder="What kind of role are you aiming for? (e.g. junior graphic designer, warehouse manager)" style="margin-top:14px">
      <div class="runbar"><button class="cta" id="bRun">Build my CV →</button></div>
      <div id="bOut"></div>`;
    $("#bRun").onclick = async () => {
      const intake = $("#bIntake").value.trim();
      if (intake.length < 120) return toast("Give me more to work with — even rough notes.");
      $("#bOut").innerHTML = loadingHTML("Building from scratch…");
      try {
        const cv = safeJson(await generate("build_cv", { intake, target: $("#bTarget").value }));
        S.profile = cv;
        $("#bOut").innerHTML = `<p class="small muted noprint" style="text-align:center;margin-top:20px">✓ Saved as your Master Profile — every other tool now uses it.</p>` + renderCvDoc(cv);
        wireCvDocActions(cv, { role: cv.title || "New CV" });
        renderBadge();
      } catch (e) { $("#bOut").innerHTML = e.message === "locked" ? "" : `<div class="err">${esc(e.message)} — retry.</div>`; }
    };
  },

  /* ---------- Cover Letter ---------- */
  letter() {
    const st = { cv: "" };
    app.innerHTML = `
      <h1 class="page">Letters that sound like <em>you wrote them.</em></h1>
      <p class="lede">No "I am writing to express my interest." A hook, your real experience, their actual need. ${S.voice ? "Voice sample active ✓" : "Tip: add a writing sample in My Profile so it matches your voice."}</p>
      <div class="panels">${cvSourceHTML("l")}${jobInputHTML("l")}</div>
      <div class="row gap" style="margin-top:14px;flex-wrap:wrap">
        <span class="small muted">Tone:</span>
        ${["professional", "warm & personal", "confident & direct", "academic"].map((t, i) => `<button class="ghost mini toneBtn ${i === 0 ? "active" : ""}" data-tone="${t}" style="${i === 0 ? "background:var(--ink);color:var(--paper)" : ""}">${t}</button>`).join("")}
      </div>
      <div class="runbar"><button class="cta" id="lRun">Write my letter →</button></div>
      <div id="lOut"></div>`;
    wireCvSource("l", st); wireJobFetch("l");
    let tone = "professional";
    app.querySelectorAll(".toneBtn").forEach((b) => b.onclick = () => { tone = b.dataset.tone; app.querySelectorAll(".toneBtn").forEach((x) => x.style = ""); b.style = "background:var(--ink);color:var(--paper)"; });
    $("#lRun").onclick = async () => {
      const job = $("#lText").value.trim();
      if (!st.cv || job.length < 80) return toast("Need both your CV and a full posting.");
      $("#lOut").innerHTML = loadingHTML("Finding the hook…");
      try {
        const text = await generate("cover_letter", { cvText: st.cv, jobText: job, tone, voiceSample: S.voice });
        $("#lOut").innerHTML = `<div class="letterdoc" id="letterdoc">${esc(text.trim())}</div>
          <div class="runbar noprint" style="justify-content:center">
            <button class="cta" onclick="window.print()">Download as PDF</button>
            <button class="ghost" id="lCopy">Copy text</button>
            <button class="ghost" id="lTrack">＋ Add to Tracker</button></div>`;
        $("#lCopy").onclick = () => { navigator.clipboard.writeText(text.trim()); toast("Copied."); };
        $("#lTrack").onclick = () => { addToTracker({ role: "Cover letter sent" }); toast("Tracked."); };
      } catch (e) { $("#lOut").innerHTML = e.message === "locked" ? "" : `<div class="err">${esc(e.message)} — retry.</div>`; }
    };
  },

  /* ---------- Answer Bank ---------- */
  answers() {
    const st = { cv: "" };
    const saved = S.answers;
    app.innerHTML = `
      <h1 class="page">Never type "describe a challenge" <em>twice.</em></h1>
      <p class="lede">Draft answers to those repetitive portal questions from your real background — then bank them for reuse.</p>
      <div class="panels">${cvSourceHTML("a")}
        <div class="panel"><div class="panel-head"><span>The question</span></div>
        <textarea id="aQ" placeholder='e.g. "Why do you want to work here?" or "Describe a time you handled conflict."'></textarea></div></div>
      <div class="runbar"><button class="cta" id="aRun">Draft answer →</button></div>
      <div id="aOut"></div>
      <hr><h3 class="serif" style="font-size:24px;margin:0 0 14px">Your bank (${saved.length})</h3>
      <div id="aBank">${saved.map((q, i) => `<div class="qa"><h4>${esc(q.q)}</h4><p>${esc(q.a)}</p>
        <div class="acts"><button class="ghost mini" data-copy="${i}">Copy</button><button class="ghost mini danger" data-rm="${i}">Delete</button></div></div>`).join("") || `<p class="muted small">Nothing banked yet.</p>`}</div>`;
    wireCvSource("a", st);
    $("#aRun").onclick = async () => {
      const q = $("#aQ").value.trim();
      if (!st.cv || q.length < 8) return toast("Need your CV and a question.");
      $("#aOut").innerHTML = loadingHTML("Drafting…");
      try {
        const a = (await generate("answer", { cvText: st.cv, question: q })).trim();
        $("#aOut").innerHTML = `<div class="qa"><h4>${esc(q)}</h4><p>${esc(a)}</p>
          <div class="acts"><button class="cta" id="aSave" style="padding:9px 18px;font-size:13px">Save to bank</button>
          <button class="ghost" id="aCopy">Copy</button></div></div>`;
        $("#aSave").onclick = () => { const s = S.answers; s.unshift({ q, a }); S.answers = s; views.answers(); toast("Banked."); };
        $("#aCopy").onclick = () => { navigator.clipboard.writeText(a); toast("Copied."); };
      } catch (e) { $("#aOut").innerHTML = e.message === "locked" ? "" : `<div class="err">${esc(e.message)}</div>`; }
    };
    app.querySelectorAll("[data-copy]").forEach((b) => b.onclick = () => { navigator.clipboard.writeText(S.answers[+b.dataset.copy].a); toast("Copied."); });
    app.querySelectorAll("[data-rm]").forEach((b) => b.onclick = () => { const s = S.answers; s.splice(+b.dataset.rm, 1); S.answers = s; views.answers(); });
  },

  /* ---------- Concierge (freeform) ---------- */
  concierge() {
    const st = { cv: "" };
    app.innerHTML = `
      <h1 class="page">Need something <em>else?</em></h1>
      <p class="lede">Describe it in your own words — a LinkedIn summary, a follow-up email, a rate negotiation reply, a portfolio blurb, a grant abstract. ApplyForge does the task, using your real profile.</p>
      <div class="panels">${cvSourceHTML("c")}
        <div class="panel"><div class="panel-head"><span>What do you need?</span></div>
        <textarea id="cReq" placeholder='e.g. "Write a polite follow-up email for an application I sent 8 days ago" or "Turn my profile into a 3-line Upwork bio for web design gigs."'></textarea></div></div>
      <textarea id="cCtx" rows="2" placeholder="Optional context: paste a posting, an email thread, anything relevant…" style="margin-top:14px"></textarea>
      <div class="runbar"><button class="cta" id="cRun">Do it →</button></div>
      <div id="cOut"></div>`;
    wireCvSource("c", st);
    $("#cRun").onclick = async () => {
      const req = $("#cReq").value.trim();
      if (req.length < 10) return toast("Describe what you need.");
      $("#cOut").innerHTML = loadingHTML("On it…");
      try {
        const out = (await generate("freeform", { cvText: st.cv, request: req, jobText: $("#cCtx").value })).trim();
        $("#cOut").innerHTML = `<div class="letterdoc">${esc(out)}</div>
          <div class="runbar noprint" style="justify-content:center"><button class="ghost" id="cCopy">Copy</button></div>`;
        $("#cCopy").onclick = () => { navigator.clipboard.writeText(out); toast("Copied."); };
      } catch (e) { $("#cOut").innerHTML = e.message === "locked" ? "" : `<div class="err">${esc(e.message)}</div>`; }
    };
  },
};
function sectionHTML(num, title, arr, render) {
  if (!arr?.length) return "";
  return `<div class="sec"><div class="sec-head"><span class="sec-num">${num}</span><span class="sec-title">${title}</span></div>${arr.map(render).join("")}</div>`;
}

/* ================= Auth & boot ================= */
document.querySelectorAll(".navbtn").forEach((b) => b.onclick = () => {
  document.querySelectorAll(".navbtn").forEach((x) => x.classList.remove("active"));
  b.classList.add("active"); views[b.dataset.view]();
});

function showAuth(msg) {
  $("#authModal").classList.remove("hidden");
  if (msg) $("#authMsg").textContent = msg;
}
async function enterApp() {
  $("#authModal").classList.add("hidden");
  if (CLOUD && session) {
    $("#userEmail").textContent = session.user.email;
    $("#logoutBtn").classList.remove("hidden");
    await cloudLoad();
  }
  renderBadge();
  views.tracker();
  if (!hasAccess()) showPaywall();
}
if (CLOUD) {
  $("#authSignIn").onclick = async () => {
    $("#authMsg").textContent = "Signing in…";
    const { data, error } = await sb.auth.signInWithPassword({ email: $("#authEmail").value.trim(), password: $("#authPass").value });
    if (error) return ($("#authMsg").textContent = error.message);
    session = data.session; enterApp();
  };
  $("#authSignUp").onclick = async () => {
    const email = $("#authEmail").value.trim(), password = $("#authPass").value;
    if (!email || password.length < 8) return ($("#authMsg").textContent = "Valid email + password of 8+ characters.");
    $("#authMsg").textContent = "Creating your account…";
    const { data, error } = await sb.auth.signUp({ email, password });
    if (error) return ($("#authMsg").textContent = error.message);
    if (!data.session) return ($("#authMsg").textContent = "Check your inbox to confirm your email, then sign in.");
    session = data.session; enterApp();
  };
  $("#logoutBtn").onclick = async () => { await sb.auth.signOut(); localStorage.clear(); location.reload(); };
  (async () => {
    const { data } = await sb.auth.getSession();
    session = data.session;
    session ? enterApp() : showAuth();
  })();
} else {
  // Local mode (Supabase not configured yet) — behaves like v1 so you can test immediately
  enterApp();
}
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
