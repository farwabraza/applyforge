/* ApplyForge — server.js
   Holds the Anthropic API key (env var), fetches job posting URLs,
   validates Lemon Squeezy license keys. Deploy target: Render. */

const express = require("express");
const path = require("path");
const app = express();

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";

/* ---------- Prompt library (server-side = consistent voice, protected IP) ---------- */
const CV_SCHEMA = `{
 "name":"", "title":"<professional headline matched to the target role>",
 "contact":{"email":"","phone":"","location":"","links":[""]},
 "summary":"<3-4 line professional summary, specific, zero clichés>",
 "experience":[{"role":"","company":"","dates":"","bullets":["<achievement-first, quantified where truthful>"]}],
 "education":[{"degree":"","school":"","dates":"","note":""}],
 "skills":{"core":[""],"tools":[""],"languages":[""]},
 "extras":[{"heading":"<e.g. Projects / Certifications / Publications>","items":[""]}]
}`;

const PROMPTS = {
  parse_profile: (p) => `Extract a structured professional profile from this document. It may be a CV or a LinkedIn "Save to PDF" export — if LinkedIn, ignore boilerplate (Contact/Top Skills sidebar labels, "Page x of y") and merge its sections (Summary, Experience, Education, Skills, Certifications) into the schema. Preserve every fact; invent nothing. Respond with ONLY valid JSON (no markdown): ${CV_SCHEMA}\n\nDOCUMENT TEXT:\n"""${p.cvText}"""`,

  gap_report: (p) => `You are the Gap Report engine in a premium career coaching app. Compare the CV against the job posting. Coach honestly; never flatter, never invent facts about the candidate.\nCV:\n"""${p.cvText}"""\nJOB POSTING:\n"""${p.jobText}"""\nRespond ONLY valid JSON, no markdown:\n{"fitScore":<0-100>,"scoreLabel":"<3-4 word blunt label>","verdict":"<2 sentences: fit + biggest blocker>","strengths":[3-4 {"title":"","note":""}],"buried":[1-2 {"title":"<qualification they have but undersold>","fix":""}],"gaps":[3-5 {"title":"","severity":"critical|moderate|minor","fix":"<specific fastest fix: named free cert, weekend project, or reframe>"}],"keywords":{"matched":[5-7 exact terms],"missing":[5-7 exact terms]},"oneMove":"<single highest-leverage action before applying>"}`,

  tailor_cv: (p) => `Rewrite this candidate's CV tailored to the job posting. Rules: use ONLY facts present in the profile — reorder, reword, cut, and quantify, never invent. Mirror the posting's exact terminology where truthful. Lead every bullet with impact.\nATS RULES (mandatory): reverse-chronological experience; include the posting's exact keywords naturally in bullets and skills; spell out every acronym once with the acronym in parentheses; standard date format "Mon YYYY – Mon YYYY"; job title in "title" should closely mirror the posting's title where truthful; no symbols or decorative characters in any text.\nPROFILE:\n"""${p.cvText}"""\nJOB POSTING:\n"""${p.jobText}"""\n${p.notes ? `CANDIDATE NOTES: """${p.notes}"""` : ""}\nRespond ONLY valid JSON, no markdown: ${CV_SCHEMA}`,

  build_cv: (p) => `Build a professional CV from scratch from this intake. Structure it properly, write achievement-first bullets, keep every fact truthful to the intake. If information is thin, keep sections lean rather than padding.\nATS RULES (mandatory): reverse-chronological; spell out acronyms once with the acronym in parentheses; standard date format "Mon YYYY – Mon YYYY"; no symbols or decorative characters.\nINTAKE (freeform answers):\n"""${p.intake}"""\n${p.target ? `TARGET ROLE/FIELD: ${p.target}` : ""}\nRespond ONLY valid JSON, no markdown: ${CV_SCHEMA}`,

  cover_letter: (p) => `Write a cover letter for this application. Voice rules: direct, warm, specific — no "I am writing to express my interest", no "passionate", no AI-sounding filler. Open with a hook tied to the company's actual need. 250-320 words. ${p.tone ? `Tone dial: ${p.tone}.` : ""}\n${p.voiceSample ? `MATCH THIS WRITING VOICE (rhythm, vocabulary, warmth):\n"""${p.voiceSample}"""` : ""}\nCANDIDATE PROFILE:\n"""${p.cvText}"""\nJOB POSTING:\n"""${p.jobText}"""\nRespond with ONLY the letter text, no preamble, no subject line unless it's an email-style application.`,

  answer: (p) => `Draft an answer to this job application question using the candidate's real background. Specific, first-person, honest, ${p.length || "120-180"} words. No clichés.\nQUESTION: "${p.question}"\nCANDIDATE PROFILE:\n"""${p.cvText}"""\n${p.jobText ? `ROLE CONTEXT:\n"""${p.jobText}"""` : ""}\nRespond with ONLY the answer text.`,

  freeform: (p) => `You are ApplyForge's concierge — a career application assistant. The user describes what they need in their own words. Do exactly that task using their profile. Be concrete and produce the deliverable directly, not advice about it.\nREQUEST: """${p.request}"""\nCANDIDATE PROFILE:\n"""${p.cvText}"""\n${p.jobText ? `JOB/GRANT CONTEXT:\n"""${p.jobText}"""` : ""}\nRespond with the deliverable only.`,
};

const MAXTOK = { parse_profile: 3000, gap_report: 1600, tailor_cv: 3500, build_cv: 3500, cover_letter: 900, answer: 500, freeform: 2500 };

/* ---------- AI generation proxy ---------- */
app.post("/api/generate", async (req, res) => {
  try {
    if (!ANTHROPIC_KEY) return res.status(500).json({ error: "Server missing ANTHROPIC_API_KEY — set it in Render → Environment." });
    const { task, payload } = req.body || {};
    if (!PROMPTS[task]) return res.status(400).json({ error: "Unknown task." });

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAXTOK[task] || 1500,
        messages: [{ role: "user", content: PROMPTS[task](payload || {}) }],
      }),
    });
    const data = await r.json();
    if (data.error) return res.status(502).json({ error: data.error.message || "Anthropic API error." });
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    res.json({ text });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Generation failed — please retry." });
  }
});

/* ---------- Job posting URL fetcher ---------- */
app.post("/api/fetch-job", async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!/^https?:\/\//i.test(url || "")) return res.status(400).json({ error: "Invalid URL." });
    const r = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; ApplyForge/1.0)", accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) throw new Error("blocked");
    let html = await r.text();
    html = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
      .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
      .replace(/<[^>]+>/g, "\n")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
      .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    if (html.length < 200) throw new Error("thin");
    res.json({ text: html.slice(0, 12000) });
  } catch {
    res.status(422).json({ error: "That site blocks automated reading (LinkedIn and Indeed usually do). Copy the posting text and paste it instead." });
  }
});

/* ---------- Lemon Squeezy license validation (no secret key needed) ---------- */
app.post("/api/license", async (req, res) => {
  try {
    const { key } = req.body || {};
    if (!key) return res.status(400).json({ valid: false, error: "No key provided." });
    const r = await fetch("https://api.lemonsqueezy.com/v1/licenses/validate", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ license_key: key.trim() }),
    });
    const data = await r.json();
    res.json({ valid: !!data.valid, status: data.license_key?.status || null });
  } catch {
    res.status(500).json({ valid: false, error: "License check failed — retry." });
  }
});

app.get("/health", (_q, s) => s.json({ ok: true }));
app.use((_q, s) => s.sendFile(path.join(__dirname, "public", "index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ApplyForge running on :${PORT}`));
