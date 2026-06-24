const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const JOBS_DB      = '403582a0e82b4e349c300a084f332ad1';
const COMPANIES_DB = 'b3e93effd284415280a842c6ef5ffc92';
const NOTION_API   = 'https://api.notion.com/v1';

// Build em dash from char code so source file stays pure ASCII.
// String.fromCharCode(8212) === U+2014 === the em dash Notion uses in field names.
var EM = String.fromCharCode(8212);

// All Notion field names that contain an em dash, built at startup.
var F = {
  finalStatus:     'FINAL ' + EM + ' Status',
  finalFullPosting:'FINAL ' + EM + ' Full Posting',
  finalIndustry:   'FINAL ' + EM + ' Industry',
  finalTier:       'FINAL ' + EM + ' Tier',
  finalWhyItFits:  'FINAL ' + EM + ' Why It Fits',
  finalNotes:      'FINAL ' + EM + ' Notes',
  finalPostingUrl: 'FINAL ' + EM + ' Job Posting URL',
  m1Score:         'Module 1 ' + EM + ' Keyword Score',
  m1Raw:           'Module 1 ' + EM + ' Keywords (Raw)',
  m1Cleaned:       'Module 1 ' + EM + ' Keywords (Cleaned)',
  m2Score:         'Module 2 ' + EM + ' Domain Score',
  m2Signals:       'Module 2 ' + EM + ' Domain Signals',
  m3Score:         'Module 3 ' + EM + ' Skills Match Score',
  m3Skills:        'Module 3 ' + EM + ' Required Skills',
  m4Score:         'Module 4 ' + EM + ' Seniority Score',
  m4Signals:       'Module 4 ' + EM + ' Seniority Signals',
  m5Score:         'Module 5 ' + EM + ' Industry Score',
  m5Signals:       'Module 5 ' + EM + ' Industry Signals',
  m6Summary:       'Module 6 ' + EM + ' Semantic Summary',
  m7Score:         'Module 7 ' + EM + ' Hybrid Score',
  m7Summary:       'Module 7 ' + EM + ' Weighted Summary',
  m8Modules:       'Module 8 ' + EM + ' Recommended Resume Modules',
  m8Match:         'Module 8 ' + EM + ' Match Summary (Formatted)'
};

// --- Notion helpers -----------------------------------------------------------

function notionHeaders(token) {
  return {
    'Authorization': 'Bearer ' + token,
    'Content-Type': 'application/json',
    'Notion-Version': '2022-06-28'
  };
}

// Short rich_text (<=2000 chars)
function rt(text) {
  if (!text) return [];
  return [{ type: 'text', text: { content: String(text).slice(0, 2000) } }];
}

// Long rich_text - splits into 2000-char blocks (up to 10000 chars total)
function rtLong(text) {
  if (!text) return [];
  var str = String(text);
  var chunks = [];
  for (var i = 0; i < str.length && chunks.length < 5; i += 2000) {
    chunks.push({ type: 'text', text: { content: str.slice(i, i + 2000) } });
  }
  return chunks;
}

function sel(name) {
  if (!name) return null;
  return { name: String(name) };
}

function multiSel(arr) {
  if (!arr || !Array.isArray(arr)) return [];
  return arr.slice(0, 10).map(function(n) { return { name: String(n) }; });
}

async function notionRequest(method, endpoint, body, token) {
  var res = await fetch(NOTION_API + endpoint, {
    method: method,
    headers: notionHeaders(token),
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    var err = await res.text();
    throw new Error('Notion ' + method + ' ' + endpoint + ' -> ' + res.status + ': ' + err);
  }
  return res.json();
}

// --- Company helpers ----------------------------------------------------------

async function findCompany(companyName, token) {
  var result = await notionRequest('POST', '/databases/' + COMPANIES_DB + '/query', {
    filter: {
      property: 'Company',
      title: { contains: String(companyName).slice(0, 50) }
    },
    page_size: 1
  }, token);
  return result.results && result.results.length > 0 ? result.results[0] : null;
}

async function createCompany(data, token) {
  var props = {
    'Company': { title: rt(data.companyName) }
  };
  if (data.companyIndustry)       props['Industry']                   = { rich_text: rt(data.companyIndustry) };
  if (data.companyHeadquarters)   props['Headquarters']               = { rich_text: rt(data.companyHeadquarters) };
  if (data.companyEmployeeCount)  props['Employee Count']             = { number: data.companyEmployeeCount };
  if (data.companySummary)        props['Company Summary']            = { rich_text: rt(data.companySummary) };
  if (data.companyPrimaryProduct) props['Primary Product / Platform'] = { rich_text: rt(data.companyPrimaryProduct) };
  if (data.companyTechStack)      props['Tech Stack (If Known)']      = { rich_text: rt(data.companyTechStack) };
  if (data.companyType)           props['Company Type']               = { select: sel(data.companyType) };
  if (data.companyWebsite)        props['Website']                    = { url: data.companyWebsite };

  return notionRequest('POST', '/pages', {
    parent: { database_id: COMPANIES_DB },
    properties: props
  }, token);
}


// Map fit assessment to Notion Status option
function getStatusFromFit(fitAssessment) {
  if (!fitAssessment) return 'Under Evaluation';
  var f = fitAssessment.toLowerCase();
  if (f.includes('strong'))   return 'Evaluated – Strong';
  if (f.includes('moderate')) return 'Evaluated – Moderate';
  if (f.includes('stretch'))  return 'Evaluated – Weak';
  return 'Evaluated – Pass';
}

// Map hybrid score to FINAL — Status option
function getFinalStatusFromScore(score) {
  if (!score || score < 65) return 'Low Match';
  if (score >= 80) return 'High Match';
  return 'Evaluated';
}

// --- Job posting helper -------------------------------------------------------

async function createJobPosting(data, postingText, postingUrl, token) {
  var today    = new Date().toISOString().split('T')[0];
  var tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];

  var props = {
    'Job Title 1':          { title:     rt(data.jobTitle) },
    'Company Name (Text)':  { rich_text: rt(data.companyName) },
    'Location 1':           { rich_text: rt(data.location) },
    'Source Type':          { select:    { name: 'Job Board' } },
    'Lane':                 { select:    { name: 'Traditional Job Search' } },
    'Next Action':          { rich_text: rt('Review & Tailor Resume') },
    'Posting Raw':          { rich_text: rtLong(postingText) },
    'Full Posting':         { rich_text: rtLong(postingText) },
    'Date Evaluated':       { date:      { start: today } },
    'Next Action Date':     { date:      { start: tomorrow } }
  };

  // Fields with em-dash names (using F.* constants)
  props['Status']           = { status:    { name: getStatusFromFit(data.fitAssessment) } };
  props[F.finalStatus]      = { select:    { name: getFinalStatusFromScore(data.module7HybridScore) } };
  props[F.finalFullPosting] = { rich_text: rtLong(postingText) };
  props[F.m6Summary]        = { rich_text: rt('Semantic scoring unavailable') };

  // Selects - only write if value present
  if (data.workModel)     props['Work Model 1']   = { select: sel(data.workModel) };
  if (data.seniority)     props['Seniority']      = { select: sel(data.seniority) };
  if (data.roleType)      props['Role Type']       = { select: sel(data.roleType) };
  if (data.industry)      props['Industry']        = { select: sel(data.industry) };
  if (data.finalIndustry) props[F.finalIndustry]   = { select: sel(data.finalIndustry) };
  if (data.finalTier)     props[F.finalTier]        = { select: sel(data.finalTier) };
  if (data.fitAssessment) props['Fit Assessment']  = { select: sel(data.fitAssessment) };

  // Numbers
  if (data.matchScore != null)              props['Match Score']  = { number: data.matchScore };
  if (data.module1KeywordScore != null)     props[F.m1Score]      = { number: data.module1KeywordScore };
  if (data.module2DomainScore != null)      props[F.m2Score]      = { number: data.module2DomainScore };
  if (data.module3SkillsMatchScore != null) props[F.m3Score]      = { number: data.module3SkillsMatchScore };
  if (data.module4SeniorityScore != null)   props[F.m4Score]      = { number: data.module4SeniorityScore };
  if (data.module5IndustryScore != null)    props[F.m5Score]      = { number: data.module5IndustryScore };
  if (data.module7HybridScore != null)      props[F.m7Score]      = { number: data.module7HybridScore };
  if (data.salaryMin)                       props['Salary Min']   = { number: data.salaryMin };
  if (data.salaryMax)                       props['Salary Max']   = { number: data.salaryMax };

  // Long text fields
  if (data.module1KeywordsRaw)        props[F.m1Raw]      = { rich_text: rt(data.module1KeywordsRaw) };
  if (data.module1KeywordsCleaned)    props[F.m1Cleaned]  = { rich_text: rt(data.module1KeywordsCleaned) };
  if (data.module2DomainSignals)      props[F.m2Signals]  = { rich_text: rt(data.module2DomainSignals) };
  if (data.module3RequiredSkills)     props[F.m3Skills]   = { rich_text: rt(data.module3RequiredSkills) };
  if (data.module4SenioritySignals)   props[F.m4Signals]  = { rich_text: rt(data.module4SenioritySignals) };
  if (data.module5IndustrySignals)    props[F.m5Signals]  = { rich_text: rt(data.module5IndustrySignals) };
  if (data.module7WeightedSummary)    props[F.m7Summary]  = { rich_text: rt(data.module7WeightedSummary) };
  if (data.module8RecommendedModules) props[F.m8Modules]  = { rich_text: rt(data.module8RecommendedModules) };
  if (data.module8MatchSummary)       props[F.m8Match]    = { rich_text: rt(data.module8MatchSummary) };
  if (data.finalWhyItFits)            props[F.finalWhyItFits]  = { rich_text: rt(data.finalWhyItFits) };
  if (data.gapsRisks)                 props['Gaps/Risks']      = { rich_text: rt(data.gapsRisks) };
  if (data.evaluationNotes)           props['Evaluation Notes']= { rich_text: rt(data.evaluationNotes) };
  if (data.compNotes)                 props['Comp Notes']       = { rich_text: rt(data.compNotes) };
  if (data.finalNotes)                props[F.finalNotes]      = { rich_text: rt(data.finalNotes) };

  // Multi-select
  if (data.keyStrengths && data.keyStrengths.length > 0) {
    props['Key Strengths'] = { multi_select: multiSel(data.keyStrengths) };
  }

  // URLs
  if (postingUrl) {
    props['Posting URL 1']    = { url: postingUrl };
    props[F.finalPostingUrl]  = { url: postingUrl };
  }

  return notionRequest('POST', '/pages', {
    parent: { database_id: JOBS_DB },
    properties: props
  }, token);
}

async function linkCompanyToPosting(jobPageId, companyPageId, token) {
  return notionRequest('PATCH', '/pages/' + jobPageId, {
    properties: {
      'Company 1': { relation: [{ id: companyPageId }] }
    }
  }, token);
}

// --- Claude analysis prompt ---------------------------------------------------

var SYSTEM_PROMPT = 'You are a job posting analysis agent for a career intelligence platform. Analyze job postings and return ONLY a JSON object - no preamble, no markdown, no explanation.';

function buildAnalysisPrompt(postingText, postingUrl) {
  return 'Analyze this job posting and return ONLY valid JSON with no other text.\n\n' +
    'JOB POSTING URL: ' + (postingUrl || 'Not provided') + '\n\n' +
    'JOB POSTING TEXT:\n' + postingText + '\n\n' +
    'Return this exact JSON structure:\n' +
    '{\n' +
    '  "jobTitle": "exact job title from posting",\n' +
    '  "companyName": "normalized company name",\n' +
    '  "location": "city/state or Remote",\n' +
    '  "workModel": "Remote OR Hybrid OR On-Site",\n' +
    '  "seniority": "one of: IC-Senior, IC-Staff, IC-Principal, Manager, Sr. Manager, Director, Sr. Director, VP, SVP, C-Level",\n' +
    '  "roleType": "one of: Product Management, Product Operations, Program Management, Process/Ops Leadership, Implementation, Consulting, Other",\n' +
    '  "industry": "one of: Technology, Pharma/Life Sciences, Financial Services, Travel/Hospitality, Healthcare, Government/Defense, Consulting, Other",\n' +
    '  "finalIndustry": "one of: SaaS, FinTech, HealthTech, Enterprise Tech, Travel Tech, Marketplace, Product Studio",\n' +
    '  "finalTier": "one of: Small (50-200), Mid (200-1000), Large (1000+)",\n' +
    '  "salaryMin": null,\n' +
    '  "salaryMax": null,\n' +
    '  "module1KeywordsRaw": "15-20 raw keywords from the posting, comma-separated",\n' +
    '  "module1KeywordsCleaned": "10 priority deduplicated keywords, comma-separated",\n' +
    '  "module1KeywordScore": 72,\n' +
    '  "module2DomainSignals": "2-3 sentences on domain alignment",\n' +
    '  "module2DomainScore": 68,\n' +
    '  "module3RequiredSkills": "required skills, comma-separated",\n' +
    '  "module3SkillsMatchScore": 75,\n' +
    '  "module4SenioritySignals": "seniority signals from posting",\n' +
    '  "module4SeniorityScore": 80,\n' +
    '  "module5IndustrySignals": "industry signals from posting",\n' +
    '  "module5IndustryScore": 70,\n' +
    '  "module7HybridScore": 73,\n' +
    '  "module7WeightedSummary": "Hybrid = 0.50xModule1 + 0.30xModule2 + 0.20xModule4 = X",\n' +
    '  "module8RecommendedModules": "8-10 resume module names, comma-separated",\n' +
    '  "module8MatchSummary": "2-3 sentence match summary",\n' +
    '  "matchScore": 73,\n' +
    '  "fitAssessment": "one of: Strong Fit, Moderate Fit, Stretch, Long Shot, Not a Fit",\n' +
    '  "finalWhyItFits": "one-line fit rationale",\n' +
    '  "keyStrengths": ["Workflow Design", "Cross-Functional Leadership"],\n' +
    '  "gapsRisks": "identified gaps or risks as plain text",\n' +
    '  "evaluationNotes": "2-3 sentence scoring rationale",\n' +
    '  "compNotes": "comp notes - salary range if stated, bonus structure, equity, benefits highlights. Empty string if none mentioned",\n' +
  '  "finalNotes": "2-3 sentences on comp/location context, priority, and resume guidance",\n' +
    '  "companyWebsite": null,\n' +
    '  "companyIndustry": "industry text",\n' +
    '  "companyHeadquarters": "HQ city/state if known",\n' +
    '  "companyEmployeeCount": null,\n' +
    '  "companySummary": "1-2 sentence company overview",\n' +
    '  "companyPrimaryProduct": "main product or platform if mentioned",\n' +
    '  "companyTechStack": "tech stack if mentioned",\n' +
    '  "companyType": "one of: Employer, Vendor, Partner, Recruiting Agency, Staffing Firm, Consulting Firm"\n' +
    '}\n\n' +
    'Scoring rules:\n' +
    '- Module 1 (Keywords 0-100): keyword density and relevance to product ops / program management\n' +
    '- Module 2 (Domain 0-100): alignment with product operations, workflow design, SaaS\n' +
    '- Module 3 (Skills 0-100): match to Workflow Design, Cross-Functional Leadership, SaaS Implementation, Global Ops, Process Harmonization, Stakeholder Alignment, AI/Automation\n' +
    '- Module 4 (Seniority 0-100): IC-Senior through Director = high; VP+ or IC-Junior = lower\n' +
    '- Module 5 (Industry 0-100): SaaS/Tech = 85+; FinTech/HealthTech = 75+; others vary\n' +
    '- Module 7 (Hybrid): Math.round(0.50*M1 + 0.30*M2 + 0.20*M4)\n' +
    '- matchScore = Module 7 Hybrid Score\n' +
    '- fitAssessment: Strong Fit (80+), Moderate Fit (65-79), Stretch (50-64), Long Shot (35-49), Not a Fit (<35)\n' +
    '- keyStrengths: only from this list: Workflow Design, Cross-Functional Leadership, SaaS Implementation, Global Ops, Regulated Environments, Process Harmonization, Stakeholder Alignment, AI/Automation, ERP/Systems, Change Management\n\n' +
    'Return ONLY the JSON. No markdown fences, no commentary.';
}

// --- Main endpoint ------------------------------------------------------------

app.post('/api/analyze', async function(req, res) {
  var postingText = req.body.postingText;
  var postingUrl  = req.body.postingUrl;

  if (!postingText || postingText.length < 100) {
    return res.status(400).json({ error: 'Posting text too short' });
  }

  var ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  var NOTION_TOKEN  = process.env.NOTION_TOKEN;

  if (!ANTHROPIC_KEY || !NOTION_TOKEN) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  try {
    // Step 1: Claude analysis
    var claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildAnalysisPrompt(postingText, postingUrl) }]
      })
    });

    if (!claudeRes.ok) {
      var claudeErr = await claudeRes.text();
      throw new Error('Claude API error: ' + claudeRes.status + ' - ' + claudeErr);
    }

    var claudeData  = await claudeRes.json();
    var textContent = claudeData.content.filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('');
    var jsonMatch   = textContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in Claude response');
    var data = JSON.parse(jsonMatch[0]);

    // Step 2: Find or create company
    var companyPageId = null;
    var companyCreated = false;
    try {
      var existing = await findCompany(data.companyName, NOTION_TOKEN);
      if (existing) {
        companyPageId = existing.id;
        console.log('Found existing company:', data.companyName, companyPageId);
      } else {
        var newCo = await createCompany(data, NOTION_TOKEN);
        companyPageId = newCo.id;
        companyCreated = true;
        console.log('Created new company:', data.companyName, companyPageId);
      }
    } catch (companyErr) {
      console.error('Company step error (non-fatal):', companyErr.message);
    }

    // Step 3: Create job posting
    var jobPage   = await createJobPosting(data, postingText, postingUrl, NOTION_TOKEN);
    var jobPageId = jobPage.id;
    console.log('Created job posting:', data.jobTitle, jobPageId);

    // Step 4: Back-link company to job posting
    if (jobPageId && companyPageId) {
      try {
        await linkCompanyToPosting(jobPageId, companyPageId, NOTION_TOKEN);
        console.log('Linked company', companyPageId, 'to job posting', jobPageId);
      } catch (linkErr) {
        console.error('Backlink step error (non-fatal):', linkErr.message);
      }
    }

    res.json({
      success:       true,
      jobTitle:      data.jobTitle      || '',
      companyName:   data.companyName   || '',
      location:      data.location      || '',
      workModel:     data.workModel     || '',
      seniority:     data.seniority     || '',
      industry:      data.industry      || '',
      salaryMin:     data.salaryMin     || null,
      salaryMax:     data.salaryMax     || null,
      hybridScore:   data.module7HybridScore    || 0,
      fitAssessment: data.fitAssessment          || '',
      status:        'Needs Review',
      keywordsScore: data.module1KeywordScore    || 0,
      domainScore:   data.module2DomainScore     || 0,
      skillsScore:   data.module3SkillsMatchScore|| 0,
      seniorityScore:data.module4SeniorityScore  || 0,
      industryScore: data.module5IndustryScore   || 0,
      keysCleaned:   data.module1KeywordsCleaned || '',
      domainSignals: data.module2DomainSignals   || '',
      fitRationale:  data.finalWhyItFits         || '',
      gapsRisks:     data.gapsRisks              || '',
      finalNotes:    data.finalNotes             || '',
      companyCreated: companyCreated,
      companyPageId: companyPageId || null,
      contactsFound: false
    });

  } catch (err) {
    console.error('Pipeline error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// --- Enrichment endpoint ------------------------------------------------------

// Serper.dev web search helper (returns top 5 snippet strings)
async function serperSearch(query, apiKey) {
  try {
    var r = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: 5 })
    });
    if (!r.ok) return '';
    var d = await r.json();
    var snippets = (d.organic || []).map(function(x) {
      return (x.title || '') + ': ' + (x.snippet || '');
    });
    if (d.answerBox && d.answerBox.answer) snippets.unshift('Answer: ' + d.answerBox.answer);
    return snippets.join('\n');
  } catch (e) {
    return '';
  }
}

app.post('/api/enrich', async function(req, res) {
  var companyPageId = req.body.companyPageId;
  var companyName   = req.body.companyName;

  if (!companyPageId || !companyName) {
    return res.status(400).json({ error: 'companyPageId and companyName required' });
  }

  var ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  var NOTION_TOKEN  = process.env.NOTION_TOKEN;

  if (!ANTHROPIC_KEY || !NOTION_TOKEN) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  try {
    // Step 1: Read existing company record to find empty fields
    var existing     = await notionRequest('GET', '/pages/' + companyPageId, null, NOTION_TOKEN);
    var ep           = existing.properties || {};

    function propEmpty(p) {
      if (!p) return true;
      if (p.type === 'rich_text') return !p.rich_text || p.rich_text.length === 0 || p.rich_text[0].plain_text === '';
      if (p.type === 'url')       return !p.url;
      if (p.type === 'number')    return p.number === null || p.number === undefined;
      if (p.type === 'select')    return !p.select || !p.select.name;
      return true;
    }

    // Step 2a: Web search (if SERPER_API_KEY is set)
    var SERPER_KEY = process.env.SERPER_API_KEY || '';
    var searchContext = '';
    if (SERPER_KEY) {
      console.log('Running Serper searches for:', companyName);
      var [res1, res2, res3] = await Promise.all([
        serperSearch(companyName + ' headquarters address phone number', SERPER_KEY),
        serperSearch(companyName + ' HR recruiter hiring manager talent acquisition', SERPER_KEY),
        serperSearch(companyName + ' company overview industry employees funding', SERPER_KEY)
      ]);
      searchContext = [
        '=== Address / Phone ===', res1,
        '=== HR / Recruiting Contacts ===', res2,
        '=== Company Overview ===', res3
      ].join('\n');
    }

    // Step 2b: Claude call — structure web search results (or use training knowledge as fallback)
    var contextSection = searchContext
      ? 'WEB SEARCH RESULTS:\n' + searchContext + '\n\nUsing the web search results above (prefer them over your training data), '
      : 'Using your training knowledge, ';

    var enrichLines = [
      contextSection + "extract factual information about \"" + companyName + "\" and return ONLY valid JSON.",
      "",
      "Return ONLY valid JSON. Use null for any field you cannot find evidence for.",
      "Do NOT fabricate data. Only include values that appear in the search results or that you are highly confident about.",
      "For recruiter/HR contacts: pick the single most senior person per role group (Recruiter, HR Contact, Hiring Manager).",
      "",
      "{",
      "  \"website\": \"official website URL or null\",",
      "  \"headquarters\": \"HQ city and state or null\",",
      "  \"companyAddress\": \"full street address or null\",",
      "  \"companyPhone\": \"main corporate phone number or null\",",
      "  \"industry\": \"primary industry or null\",",
      "  \"employeeCount\": null,",
      "  \"glassdoorRating\": null,",
      "  \"fundingStage\": \"one of: Pre-seed, Seed, Series A, Series B, Series C+, Bootstrapped, Public, Unknown — or null\",",
      "  \"companySummary\": \"2-sentence overview or null\",",
      "  \"primaryProduct\": \"main product or platform or null\",",
      "  \"techStack\": \"known tech stack or null\",",
      "  \"companyType\": \"one of: Employer, Vendor, Recruiting Agency, Staffing Firm, Consulting Firm or null\",",
      "  \"recruiterName\": \"most senior recruiter/talent acquisition contact name or null\",",
      "  \"recruiterTitle\": \"their title or null\",",
      "  \"recruiterLinkedInUrl\": null,",
      "  \"hrContactName\": \"HR director or people ops contact name or null\",",
      "  \"hrContactTitle\": \"their title or null\",",
      "  \"hrLinkedInUrl\": null,",
      "  \"hiringManagerName\": \"hiring manager or head of product/ops name or null\",",
      "  \"hiringManagerTitle\": \"their title or null\",",
      "  \"hiringManagerLinkedInUrl\": null",
      "}",
      "",
      "Return ONLY the JSON. No markdown fences, no commentary."
    ];
    var enrichPrompt = enrichLines.join("\n");

    var claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: 'You are a company research assistant. Return only valid JSON with confident factual data from your training. Never fabricate data.',
        messages: [{ role: 'user', content: enrichPrompt }]
      })
    });

    if (!claudeRes.ok) throw new Error('Claude enrichment error: ' + claudeRes.status);
    var cData       = await claudeRes.json();
    var cText       = cData.content.filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('');
    var cMatch      = cText.match(/\{[\s\S]*\}/);
    if (!cMatch) throw new Error('No JSON from enrichment call');
    var ed          = JSON.parse(cMatch[0]);

    console.log('Enrichment Claude output for', companyName, ':', JSON.stringify(ed));
    console.log('Serper used:', !!SERPER_KEY, '| searchContext length:', searchContext.length);

    // Which fields already have values (will be skipped)
    var alreadyFilled = Object.keys(ep).filter(function(k) { return !propEmpty(ep[k]); });
    console.log('Already filled fields (will skip):', alreadyFilled.join(', '));

    // Step 3: Build update payload — only write to empty fields
    var updates = {};
    if (propEmpty(ep['Website'])                     && ed.website)                  updates['Website']                    = { url: ed.website };
    if (propEmpty(ep['Headquarters'])                && ed.headquarters)             updates['Headquarters']               = { rich_text: rt(ed.headquarters) };
    if (propEmpty(ep['Company Address'])             && ed.companyAddress)           updates['Company Address']            = { rich_text: rt(ed.companyAddress) };
    if (propEmpty(ep['Company Phone'])               && ed.companyPhone)             updates['Company Phone']              = { phone_number: String(ed.companyPhone) };
    if (propEmpty(ep['Industry'])                    && ed.industry)                 updates['Industry']                   = { rich_text: rt(ed.industry) };
    if (propEmpty(ep['Employee Count'])              && ed.employeeCount)            updates['Employee Count']             = { number: Number(ed.employeeCount) };
    if (propEmpty(ep['Glassdoor Rating'])            && ed.glassdoorRating)          updates['Glassdoor Rating']           = { number: Number(ed.glassdoorRating) };
    if (propEmpty(ep['Funding Stage'])               && ed.fundingStage)             updates['Funding Stage']              = { select: sel(ed.fundingStage) };
    if (propEmpty(ep['Company Summary'])             && ed.companySummary)           updates['Company Summary']            = { rich_text: rt(ed.companySummary) };
    if (propEmpty(ep['Primary Product / Platform'])  && ed.primaryProduct)           updates['Primary Product / Platform'] = { rich_text: rt(ed.primaryProduct) };
    if (propEmpty(ep['Tech Stack (If Known)'])       && ed.techStack)                updates['Tech Stack (If Known)']      = { rich_text: rt(ed.techStack) };
    if (propEmpty(ep['Company Type'])                && ed.companyType)              updates['Company Type']               = { select: sel(ed.companyType) };
    if (propEmpty(ep['Recruiter Name'])              && ed.recruiterName)            updates['Recruiter Name']             = { rich_text: rt(ed.recruiterName) };
    if (propEmpty(ep['Recruiter Title'])             && ed.recruiterTitle)           updates['Recruiter Title']            = { rich_text: rt(ed.recruiterTitle) };
    if (propEmpty(ep['Recruiter LinkedIn URL'])      && ed.recruiterLinkedInUrl)     updates['Recruiter LinkedIn URL']     = { url: ed.recruiterLinkedInUrl };
    if (propEmpty(ep['HR Contact Name'])             && ed.hrContactName)            updates['HR Contact Name']            = { rich_text: rt(ed.hrContactName) };
    if (propEmpty(ep['HR Contact Title'])            && ed.hrContactTitle)           updates['HR Contact Title']           = { rich_text: rt(ed.hrContactTitle) };
    if (propEmpty(ep['HR Contact LinkedIn URL'])     && ed.hrLinkedInUrl)            updates['HR Contact LinkedIn URL']    = { url: ed.hrLinkedInUrl };
    if (propEmpty(ep['Hiring Manager Name'])         && ed.hiringManagerName)        updates['Hiring Manager Name']        = { rich_text: rt(ed.hiringManagerName) };
    if (propEmpty(ep['Hiring Manager Title'])        && ed.hiringManagerTitle)       updates['Hiring Manager Title']       = { rich_text: rt(ed.hiringManagerTitle) };
    if (propEmpty(ep['Hiring Manager LinkedIn URL']) && ed.hiringManagerLinkedInUrl) updates['Hiring Manager LinkedIn URL']= { url: ed.hiringManagerLinkedInUrl };

    var fieldsUpdated = Object.keys(updates).length;
    if (fieldsUpdated > 0) {
      await notionRequest('PATCH', '/pages/' + companyPageId, { properties: updates }, NOTION_TOKEN);
    }


    res.json({
      success:        true,
      companyName:    companyName,
      fieldsUpdated:  fieldsUpdated,
      fieldsList:     Object.keys(updates),
      debug: {
        serperUsed:    !!SERPER_KEY,
        serperChars:   searchContext.length,
        claudeGot:     ed,
        alreadyFilled: alreadyFilled
      }
    });

  } catch (err) {
    console.error('Enrichment error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('*', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('Career Intelligence Demo running on port ' + PORT); });
