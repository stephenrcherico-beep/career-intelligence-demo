const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PIPELINE_SYSTEM = `You are the Job Intake Pipeline agent for a career management platform.
You have access to Notion via MCP. Process job postings end-to-end through all 4 pipeline steps.

DATABASE IDs:
- Job Postings DB: 403582a0e82b4e349c300a084f332ad1
- Companies DB: b3e93effd284415280a842c6ef5ffc92
- Modular Resume Library: d74582b89b3e44de8fcb7437a59dadb1

GLOBAL RULES:
- Never rename, delete, or clear fields
- Never overwrite non-empty fields (except scoring fields)
- Never create duplicate company records
- Never require user confirmation mid-pipeline
- Always complete all 4 steps even if individual steps return partial results
- If any step fails, log it and continue`;

function buildPrompt(postingText, postingUrl) {
  return `Process this job posting through the complete 4-step pipeline.

JOB POSTING URL: ${postingUrl || 'Not provided'}

JOB POSTING TEXT:
${postingText}

STEP 1 — Create Job Posting record in DB 403582a0e82b4e349c300a084f332ad1:
Extract and write all metadata:
- Job Title 1 (from title line or heading)
- Company Name (Text) (normalized)
- Location 1 (city/state or Remote)
- Work Model 1 (Remote / Hybrid / On-Site)
- Seniority (IC-Senior / IC-Staff / Manager / Director / VP)
- Role Type (Product Operations / Program Management / Process/Ops Leadership / Implementation / Other)
- Industry (Technology / Financial Services / Healthcare / Consulting / Other)
- FINAL — Industry (SaaS / FinTech / HealthTech / Enterprise Tech / Travel Tech / Marketplace / Product Studio)
- FINAL — Tier (Small 50-200 / Mid 200-1000 / Large 1000+)
- Salary Min, Salary Max (numeric USD, blank if not posted)
- Posting Raw = full posting text
- FINAL — Full Posting = full posting text
- Posting URL 1 = ${postingUrl || 'null'}
- FINAL — Job Posting URL = ${postingUrl || 'null'}
- Source Type = Job Board

Run all 8 scoring modules:
MODULE 1: Extract keywords, deduplicate, rank → Module 1 Keywords Raw, Cleaned, Score (0-100)
MODULE 2: Classify domain → Module 2 Domain Signals, Score (0-100)
MODULE 3: Extract required skills, compare to resume library → Module 3 Required Skills, Skills Match Score (0-100)
MODULE 4: Detect seniority signals → Module 4 Seniority Signals, Score (0-100)
MODULE 5: Classify industry → Module 5 Industry Signals, Score (0-100)
MODULE 6: DISABLED — write "Semantic scoring unavailable" to summary, leave score null
MODULE 7: Hybrid Score = 0.50×Keywords + 0.30×Domain + 0.20×Seniority (Fast Intake Mode)
MODULE 8: Recommend 8-12 resume modules from library → Module 8 Recommended Resume Modules, Match Summary

Set evaluation fields:
- Match Score = Module 7 Hybrid Score
- Fit Assessment: Strong Fit (80+) / Moderate Fit (65-79) / Stretch (50-64) / Long Shot / Not a Fit (<50)
- FINAL — Why It Fits (one line)
- Key Strengths (from: Workflow Design, Cross-Functional Leadership, SaaS Implementation, Global Ops, Regulated Environments, Process Harmonization, Stakeholder Alignment, AI/Automation, ERP/Systems, Change Management)
- Gaps/Risks (plain text)
- Evaluation Notes (narrative rationale)
- Status: Evaluated – Strong (80+) / Evaluated – Moderate (65-79) / Evaluated – Weak (50-64) / Evaluated – Pass (<50)
- FINAL — Status = Needs Review
- FINAL — Notes (2-3 sentences: employment type+location+comp context, priority directive, resume tailoring guidance)
- Next Action = Review & Tailor Resume
- Date Evaluated = today
- Next Action Date = tomorrow
- Lane = Traditional Job Search

STEP 2 — Company Agent:
- Search Companies DB b3e93effd284415280a842c6ef5ffc92 for matching company name (case-insensitive)
- If not found, create new record with company name
- Enrich empty fields from posting text: Website, Industry, Headquarters, Employee Count, Company Summary, Primary Product/Platform, Tech Stack, Company Type
- Extract any contacts named in posting text (Recruiter, HR, Hiring Manager fields)
- IMPORTANT: After creating or finding the company record, save its Notion page ID (UUID) for use in Step 4

STEP 3 — Contacts Agent:
- Web search for recruiter/talent acquisition, HR/people ops, hiring manager at this company
- Search patterns: "[Company] recruiter LinkedIn", "[Company] head of HR", "[Company] VP [function]"
- Write to empty contact fields only — never overwrite existing values
- If no confident result found, leave blank

STEP 4 — Back-link:
- Update the Job Posting record created in Step 1
- Set the "Company 1" relation field using the company record's Notion page ID (UUID) from Step 2
- Use the page ID (e.g. "abc123...") directly — do NOT use the page URL
- The relation field value must be: [{ "id": "<company_page_id>" }]

After ALL steps complete, respond with ONLY this JSON (no other text):
{
  "success": true,
  "jobTitle": "string",
  "companyName": "string",
  "location": "string",
  "workModel": "string",
  "seniority": "string",
  "industry": "string",
  "salaryMin": null,
  "salaryMax": null,
  "hybridScore": 0,
  "fitAssessment": "string",
  "status": "string",
  "keywordsScore": 0,
  "domainScore": 0,
  "skillsScore": 0,
  "seniorityScore": 0,
  "industryScore": 0,
  "keysCleaned": "keyword1, keyword2, keyword3",
  "domainSignals": "string",
  "fitRationale": "string",
  "gapsRisks": "string",
  "finalNotes": "string",
  "companyCreated": true,
  "contactsFound": false
}`;
}

app.post('/api/analyze', async (req, res) => {
  const { postingText, postingUrl } = req.body;

  if (!postingText || postingText.length < 100) {
    return res.status(400).json({ error: 'Posting text too short' });
  }

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const NOTION_TOKEN = process.env.NOTION_TOKEN;

  if (!ANTHROPIC_KEY || !NOTION_TOKEN) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'mcp-client-2025-04-04'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 16000,
        system: PIPELINE_SYSTEM,
        mcp_servers: [{
          type: 'url',
          url: 'https://mcp.notion.com/mcp',
          name: 'notion',
          authorization_token: NOTION_TOKEN
        }],
        messages: [{
          role: 'user',
          content: buildPrompt(postingText, postingUrl)
        }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error('Anthropic API error: ' + response.status + ' — ' + err);
    }

    const data = await response.json();

    const textContent = data.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    const jsonMatch = textContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON result in pipeline response');

    const result = JSON.parse(jsonMatch[0]);
    if (!result.success) throw new Error('Pipeline reported failure');

    res.json(result);

  } catch (err) {
    console.error('Pipeline error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Career Intelligence Demo running on port ' + PORT));
