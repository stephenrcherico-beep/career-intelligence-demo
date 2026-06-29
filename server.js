const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const JOBS_DB      = '403582a0e82b4e349c300a084f332ad1';
const JOBS_DB_COL  = '859e4744-488d-439c-98f8-87ca4b5b8ddb'; // collection / data_source_id
const COMPANIES_DB = 'b3e93effd284415280a842c6ef5ffc92';
const RESUME_LIB   = 'd74582b89b3e44de8fcb7437a59dadb1';
const RESUME_LIB_COL = 'ef9a489f-9bb1-4ebf-b665-03b31993cc47'; // collection / data_source_id
const NOTION_API   = 'https://api.notion.com/v1';


var EM = String.fromCharCode(8212);

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
    'Notion-Version': '2025-09-03'
  };
}

// Collection-backed databases reject /query with v2025-09-03 — use v2022-06-28
function notionQueryHeaders(token) {
  return {
    'Authorization': 'Bearer ' + token,
    'Content-Type': 'application/json',
    'Notion-Version': '2022-06-28'
  };
}

async function notionQueryRequest(databaseId, body, token) {
  var res = await fetch(NOTION_API + '/databases/' + databaseId + '/query', {
    method: 'POST',
    headers: notionQueryHeaders(token),
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    var err = await res.text();
    throw new Error('Notion POST /databases/' + databaseId + '/query -> ' + res.status + ': ' + err);
  }
  return res.json();
}

function rt(text) {
  if (!text) return [];
  return [{ type: 'text', text: { content: String(text).slice(0, 2000) } }];
}

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
  // Must use notionQueryRequest (v2022-06-28) — v2025-09-03 returns invalid_request_url on /query
  var result = await notionQueryRequest(COMPANIES_DB, {
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

function getStatusFromFit(fitAssessment) {
  if (!fitAssessment) return 'Under Evaluation';
  var f = fitAssessment.toLowerCase();
  if (f.includes('strong'))   return 'Evaluated ' + String.fromCharCode(8211) + ' Strong';
  if (f.includes('moderate')) return 'Evaluated ' + String.fromCharCode(8211) + ' Moderate';
  if (f.includes('stretch'))  return 'Evaluated ' + String.fromCharCode(8211) + ' Weak';
  return 'Evaluated ' + String.fromCharCode(8211) + ' Pass';
}

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

  props['Status']           = { status:    { name: getStatusFromFit(data.fitAssessment) } };
  props[F.finalStatus]      = { select:    { name: getFinalStatusFromScore(data.module7HybridScore) } };
  props[F.finalFullPosting] = { rich_text: rtLong(postingText) };
  props[F.m6Summary]        = { rich_text: rt('Semantic scoring unavailable') };

  if (data.workModel)     props['Work Model 1']   = { select: sel(data.workModel) };
  if (data.seniority)     props['Seniority']      = { select: sel(data.seniority) };
  if (data.roleType)      props['Role Type']       = { select: sel(data.roleType) };
  if (data.industry)      props['Industry']        = { select: sel(data.industry) };
  if (data.finalIndustry) props[F.finalIndustry]   = { select: sel(data.finalIndustry) };
  if (data.finalTier)     props[F.finalTier]        = { select: sel(data.finalTier) };
  if (data.fitAssessment) props['Fit Assessment']  = { select: sel(data.fitAssessment) };

  if (data.matchScore != null)              props['Match Score']  = { number: data.matchScore };
  if (data.module1KeywordScore != null)     props[F.m1Score]      = { number: data.module1KeywordScore };
  if (data.module2DomainScore != null)      props[F.m2Score]      = { number: data.module2DomainScore };
  if (data.module3SkillsMatchScore != null) props[F.m3Score]      = { number: data.module3SkillsMatchScore };
  if (data.module4SeniorityScore != null)   props[F.m4Score]      = { number: data.module4SeniorityScore };
  if (data.module5IndustryScore != null)    props[F.m5Score]      = { number: data.module5IndustryScore };
  if (data.module7HybridScore != null)      props[F.m7Score]      = { number: data.module7HybridScore };
  if (data.salaryMin)                       props['Salary Min']   = { number: data.salaryMin };
  if (data.salaryMax)                       props['Salary Max']   = { number: data.salaryMax };

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

  if (data.keyStrengths && data.keyStrengths.length > 0) {
    props['Key Strengths'] = { multi_select: multiSel(data.keyStrengths) };
  }

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
    '  "compNotes": "comp notes if salary stated, else empty string",\n' +
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

// --- Main analysis endpoint ---------------------------------------------------

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

    var companyPageId  = null;
    var companyCreated = false;
    try {
      var existing = await findCompany(data.companyName, NOTION_TOKEN);
      if (existing) {
        companyPageId = existing.id;
      } else {
        var newCo = await createCompany(data, NOTION_TOKEN);
        companyPageId = newCo.id;
        companyCreated = true;
      }
    } catch (companyErr) {
      console.error('Company step error (non-fatal):', companyErr.message);
    }

    var jobPage   = await createJobPosting(data, postingText, postingUrl, NOTION_TOKEN);
    var jobPageId = jobPage.id;

    if (jobPageId && companyPageId) {
      try {
        await linkCompanyToPosting(jobPageId, companyPageId, NOTION_TOKEN);
      } catch (linkErr) {
        console.error('Backlink step error (non-fatal):', linkErr.message);
      }
    }

    res.json({
      success:        true,
      jobTitle:       data.jobTitle       || '',
      companyName:    data.companyName    || '',
      location:       data.location       || '',
      workModel:      data.workModel      || '',
      seniority:      data.seniority      || '',
      industry:       data.industry       || '',
      salaryMin:      data.salaryMin      || null,
      salaryMax:      data.salaryMax      || null,
      hybridScore:    data.module7HybridScore     || 0,
      fitAssessment:  data.fitAssessment           || '',
      status:         'Needs Review',
      keywordsScore:  data.module1KeywordScore     || 0,
      domainScore:    data.module2DomainScore      || 0,
      skillsScore:    data.module3SkillsMatchScore || 0,
      seniorityScore: data.module4SeniorityScore   || 0,
      industryScore:  data.module5IndustryScore    || 0,
      keysCleaned:    data.module1KeywordsCleaned  || '',
      domainSignals:  data.module2DomainSignals    || '',
      fitRationale:   data.finalWhyItFits          || '',
      gapsRisks:      data.gapsRisks               || '',
      finalNotes:     data.finalNotes              || '',
      companyCreated: companyCreated,
      companyPageId:  companyPageId || null,
      contactsFound:  false
    });

  } catch (err) {
    console.error('Pipeline error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Serper web search helper -------------------------------------------------

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

// --- Enrichment endpoint ------------------------------------------------------

app.post('/api/enrich', async function(req, res) {
  var companyPageId = req.body.companyPageId;
  var companyName   = req.body.companyName;

  if (!companyName) {
    return res.status(400).json({ error: 'companyName required' });
  }

  var ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  var NOTION_TOKEN  = process.env.NOTION_TOKEN;

  if (!ANTHROPIC_KEY || !NOTION_TOKEN) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  try {
    // Step 1: If no pageId supplied, look up the company by name in Notion
    if (!companyPageId) {
      var found = await findCompany(companyName, NOTION_TOKEN);
      if (!found) {
        return res.status(404).json({
          error: 'Company "' + companyName + '" not found in Notion. Run the analyzer first to create the record.'
        });
      }
      companyPageId = found.id;
      console.log('Found company by name:', companyName, companyPageId);
    }

    // Step 1b: Read existing record to detect empty fields
    var existing = await notionRequest('GET', '/pages/' + companyPageId, null, NOTION_TOKEN);
    var ep       = existing.properties || {};

    function propEmpty(p) {
      if (!p) return true;
      if (p.type === 'rich_text')    return !p.rich_text || p.rich_text.length === 0 || p.rich_text[0].plain_text === '';
      if (p.type === 'url')          return !p.url;
      if (p.type === 'number')       return p.number === null || p.number === undefined;
      if (p.type === 'select')       return !p.select || !p.select.name;
      if (p.type === 'phone_number') return !p.phone_number;
      if (p.type === 'email')        return !p.email;
      return true;
    }

    // Step 2a: Normalize company name for search (strip parentheticals, legal suffixes)
    var searchName = companyName
      .replace(/\s*\([^)]*\)\s*/g, ' ')   // remove (DoseSpot) style parentheticals
      .replace(/,?\s*(Inc|LLC|Corp|Ltd|Co|LP|LLP|PLC)\.?$/i, '')  // remove legal suffixes
      .replace(/\s+/g, ' ')
      .trim();
    console.log('Search name normalized:', searchName, '(from:', companyName + ')');

    // Step 2b: Five targeted Serper searches
    var SERPER_KEY  = process.env.SERPER_API_KEY || '';
    var searchContext = '';
    if (SERPER_KEY) {
      console.log('Running Serper searches for:', searchName, '(original:', companyName + ')');
      var results = await Promise.all([
        serperSearch(searchName + ' headquarters address phone number', SERPER_KEY),
        serperSearch(searchName + ' company overview employees industry funding', SERPER_KEY),
        serperSearch('"' + searchName + '" recruiter "talent acquisition" linkedin', SERPER_KEY),
        serperSearch('"' + searchName + '" "HR director" OR "head of HR" OR "people operations" OR "VP people" linkedin', SERPER_KEY),
        serperSearch('"' + searchName + '" "director of product" OR "VP operations" OR "head of product" OR "hiring manager" linkedin', SERPER_KEY)
      ]);
      searchContext = [
        '=== Address / Phone ===', results[0],
        '=== Company Overview ===', results[1],
        '=== Recruiter / Talent Acquisition (look for "First Last - Title at ' + companyName + '") ===', results[2],
        '=== HR / People Ops (look for "First Last - HR Director at ' + companyName + '") ===', results[3],
        '=== Hiring Manager / Product Ops (look for "First Last - Director at ' + companyName + '") ===', results[4]
      ].join('\n');
    }

    // Step 2b: Claude structures the search results into JSON
    var contextSection = searchContext
      ? 'WEB SEARCH RESULTS (use these as primary source):\n' + searchContext + '\n\n'
      : '';

    var enrichPrompt = contextSection +
      'Extract factual information about "' + companyName + '" and return ONLY valid JSON.\n\n' +
      'CONTACT EXTRACTION RULES:\n' +
      '- Search titles look like: "First Last - Title at Company | LinkedIn" -- extract the name and title\n' +
      '- Recruiter/Talent Acquisition -> recruiterName + recruiterTitle\n' +
      '- HR Director/People Ops/VP People -> hrContactName + hrContactTitle\n' +
      '- Director of Product/VP Ops/Hiring Manager -> hiringManagerName + hiringManagerTitle\n' +
      '- Pick the most senior person found for each role group\n' +
      '- If a linkedin.com/in/... URL appears in results, include it\n' +
      '- Use null only if NO evidence exists for that field\n\n' +
      '{\n' +
      '  "website": "official URL or null",\n' +
      '  "headquarters": "city and state or null",\n' +
      '  "companyAddress": "full street address or null",\n' +
      '  "companyPhone": "main phone number or null",\n' +
      '  "industry": "primary industry or null",\n' +
      '  "employeeCount": null,\n' +
      '  "glassdoorRating": null,\n' +
      '  "fundingStage": "Pre-seed|Seed|Series A|Series B|Series C+|Bootstrapped|Public|Unknown or null",\n' +
      '  "companySummary": "2-sentence overview or null",\n' +
      '  "primaryProduct": "main product or platform or null",\n' +
      '  "techStack": "known tech stack or null",\n' +
      '  "companyType": "Employer|Vendor|Recruiting Agency|Staffing Firm|Consulting Firm or null",\n' +
      '  "recruiterName": "full name from search results or null",\n' +
      '  "recruiterTitle": "their exact title or null",\n' +
      '  "recruiterLinkedInUrl": "linkedin.com/in/... or null",\n' +
      '  "hrContactName": "full name from search results or null",\n' +
      '  "hrContactTitle": "their exact title or null",\n' +
      '  "hrLinkedInUrl": "linkedin.com/in/... or null",\n' +
      '  "hiringManagerName": "full name from search results or null",\n' +
      '  "hiringManagerTitle": "their exact title or null",\n' +
      '  "hiringManagerLinkedInUrl": "linkedin.com/in/... or null"\n' +
      '}\n\n' +
      'Return ONLY the JSON. No markdown fences, no commentary.';

    var claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1200,
        system: 'You are a company research assistant. Extract structured data from web search results. Parse person names and titles from LinkedIn-style search snippets. Return only valid JSON.',
        messages: [{ role: 'user', content: enrichPrompt }]
      })
    });

    if (!claudeRes.ok) throw new Error('Claude enrichment error: ' + claudeRes.status);
    var cData  = await claudeRes.json();
    var cText  = cData.content.filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('');
    var cMatch = cText.match(/\{[\s\S]*\}/);
    if (!cMatch) throw new Error('No JSON from enrichment call');
    var ed = JSON.parse(cMatch[0]);

    console.log('Enrichment Claude output for', companyName, ':', JSON.stringify(ed));
    console.log('Serper used:', !!SERPER_KEY, '| context chars:', searchContext.length);

    var alreadyFilled = Object.keys(ep).filter(function(k) { return !propEmpty(ep[k]); });

    // Step 3: Write only empty fields
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
      companyPageId:  companyPageId,
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


// -- Story Ingestion Endpoint ------------------------------------------------

app.post('/api/ingest-story', async function(req, res) {
  var NOTION_TOKEN = process.env.NOTION_TOKEN || '';
  var ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
  if (!NOTION_TOKEN) return res.status(500).json({ error: 'NOTION_TOKEN not set' });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  var narrative = (req.body.narrative || '').trim();
  var employer  = (req.body.employer  || '').trim();
  var location  = (req.body.location  || '').trim();
  var startDate = (req.body.startDate || '').trim();
  var endDate   = (req.body.endDate   || '').trim();
  var jobTitles = (req.body.jobTitles || '').trim();
  var empType   = (req.body.employmentType || '').trim();
  var themes    = (req.body.themes    || '').trim();

  if (!narrative) return res.status(400).json({ error: 'narrative is required' });

  try {
    var contextBlock = [
      employer  ? 'Employer: ' + employer  : '',
      location  ? 'Location: ' + location  : '',
      startDate ? 'Start: '   + startDate  : '',
      endDate   ? 'End: '     + endDate    : '',
      jobTitles ? 'Titles: '  + jobTitles  : '',
      empType   ? 'Type: '    + empType    : '',
      themes    ? 'Themes: '  + themes     : ''
    ].filter(Boolean).join('\n');

    var systemPrompt = 'You are an expert career narrative analyst and resume writer. Return ONLY valid JSON with no markdown, no code fences, no commentary.';

    var userPrompt = 'Analyze this career story and return a single JSON object.\n\n'
      + 'STORY:\n' + narrative
      + (contextBlock ? '\n\nCONTEXT:\n' + contextBlock : '')
      + '\n\nReturn this exact JSON structure:\n'
      + '{\n'
      + '  "storyTitle": "concise title for this story (include employer if known)",\n'
      + '  "storyType": "achievement|job_story|professional_summary",\n'
      + '  "detectedSeniority": "Junior|Mid|Senior|Lead|Director|VP|C-Suite",\n'
      + '  "detectedEmployer": "employer extracted from story/context, empty string if unknown",\n'
      + '  "metadata": {\n'
      + '    "keywords": ["8 to 15 keywords"],\n'
      + '    "jobFamilies": ["1-3 from: Implementation, Systems Leadership, TPM, Product Ops, Delivery, Onboarding/CS, Operations, Hybrid, Stories"],\n'
      + '    "themes": ["2-5 themes"],\n'
      + '    "impactMetrics": ["metrics with numbers from the story"],\n'
      + '    "senioritySignals": ["signals that indicate seniority"]\n'
      + '  },\n'
      + '  "versions": {\n'
      + '    "long": "full narrative verbatim or lightly cleaned",\n'
      + '    "medium": "condensed 2-3 paragraph version: context + key actions + outcomes",\n'
      + '    "short": "2-3 sentence executive summary"\n'
      + '  },\n'
      + '  "sourceBullets": "Led X\\nBuilt Y\\nDrove Z (newline separated, 3-5 raw bullets)",\n'
      + '  "bullets": [\n'
      + '    {\n'
      + '      "text": "Resume bullet starting with past-tense action verb",\n'
      + '      "bulletType": "one of: TPM, Implementation, Product Ops, Delivery, Operations, Project Manager, Systems Leadership",\n'
      + '      "rankScore": 85,\n'
      + '      "jobFamilies": ["1-2 from exact list"],\n'
      + '      "keywords": ["2-4 keywords"]\n'
      + '    }\n'
      + '  ],\n'
      + '  "scores": { "clarity": 80, "impact": 75, "measurability": 70, "seniority": 80, "strength": 76 }\n'
      + '}\n'
      + 'Rules:\n'
      + '- jobFamilies EXACT from: Implementation, Systems Leadership, TPM, Product Ops, Delivery, Onboarding/CS, Operations, Hybrid, Stories\n'
      + '- bulletType EXACT from: TPM, Implementation, Product Ops, Delivery, Operations, Project Manager, Systems Leadership\n'
      + '- Generate 5 to 8 bullets\n'
      + '- NEVER fabricate metrics not in the original story\n'
      + '- Return ONLY the JSON object';

    var claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });
    if (!claudeRes.ok) {
      var err = await claudeRes.text();
      throw new Error('Claude API error: ' + err);
    }
    var claudeData = await claudeRes.json();
    var rawJson = claudeData.content[0].text.trim()
      .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
    var extracted = JSON.parse(rawJson);

    console.log('Ingestion extracted:', extracted.storyTitle, '| bullets:', (extracted.bullets || []).length);

    var resolvedEmployer = employer || extracted.detectedEmployer || 'Other';
    var jobFamilies = (extracted.metadata && extracted.metadata.jobFamilies) || [];
    var keywords    = ((extracted.metadata && extracted.metadata.keywords) || []).join(', ');
    var notesParts  = [];
    if (extracted.metadata && extracted.metadata.themes && extracted.metadata.themes.length)
      notesParts.push('Themes: ' + extracted.metadata.themes.join(', '));
    if (extracted.metadata && extracted.metadata.impactMetrics && extracted.metadata.impactMetrics.length)
      notesParts.push('Metrics: ' + extracted.metadata.impactMetrics.join(', '));
    if (extracted.metadata && extracted.metadata.senioritySignals && extracted.metadata.senioritySignals.length)
      notesParts.push('Seniority signals: ' + extracted.metadata.senioritySignals.join(', '));
    if (extracted.detectedSeniority)
      notesParts.push('Detected level: ' + extracted.detectedSeniority);
    var notes = notesParts.join('\n');

    var storyProps = {
      'Module':         { title: rt(extracted.storyTitle || 'Story') },
      'Section':        { select: { name: 'Story' } },
      'Job Family':     { multi_select: jobFamilies.map(function(j) { return { name: j }; }) },
      'Long Version':   { rich_text: rtLong((extracted.versions && extracted.versions.long)   || narrative) },
      'Medium Version': { rich_text: rtLong((extracted.versions && extracted.versions.medium) || '') },
      'Short Version':  { rich_text: rt((extracted.versions    && extracted.versions.short)   || '') },
      'Source Bullets': { rich_text: rtLong(extracted.sourceBullets || '') },
      'Keywords':       { rich_text: rt(keywords) },
      'Notes':          { rich_text: rtLong(notes) },
      'Batch ID':       { rich_text: rt('ingest-' + new Date().toISOString().slice(0, 10)) }
    };
    if (resolvedEmployer) storyProps['Employer'] = { select: { name: resolvedEmployer } };

    var storyPage = await notionRequest('POST', '/pages', {
      parent: { data_source_id: RESUME_LIB_COL },
      properties: storyProps
    }, NOTION_TOKEN);

    var bullets = extracted.bullets || [];
    var writtenBullets = 0;
    for (var i = 0; i < bullets.length; i++) {
      var b = bullets[i];
      if (!b.text) continue;
      var bulletProps = {
        'Module':      { title: rt(b.text) },
        'Text':        { rich_text: rt(b.text) },
        'Section':     { select: { name: 'Experience Bullet' } },
        'Bullet Type': { select: { name: b.bulletType || 'Operations' } },
        'Job Family':  { multi_select: (b.jobFamilies || []).map(function(j) { return { name: j }; }) },
        'Keywords':    { rich_text: rt((b.keywords || []).join(', ')) },
        'Rank':        { number: b.rankScore || 50 },
        'Batch ID':    { rich_text: rt('ingest-' + new Date().toISOString().slice(0, 10)) }
      };
      if (resolvedEmployer) bulletProps['Employer'] = { select: { name: resolvedEmployer } };
      await notionRequest('POST', '/pages', {
        parent: { data_source_id: RESUME_LIB_COL },
        properties: bulletProps
      }, NOTION_TOKEN);
      writtenBullets++;
    }

    console.log('Ingestion complete: story written + ' + writtenBullets + ' bullets');

    res.json({
      ok: true,
      storyTitle:     extracted.storyTitle,
      storyType:      extracted.storyType,
      seniority:      extracted.detectedSeniority,
      employer:       resolvedEmployer,
      jobFamilies:    jobFamilies,
      keywords:       (extracted.metadata && extracted.metadata.keywords) || [],
      bulletsCount:   writtenBullets,
      bullets:        bullets,
      versions: {
        short:  (extracted.versions && extracted.versions.short)  || '',
        medium: (extracted.versions && extracted.versions.medium) || ''
      },
      scores:         extracted.scores || {},
      notionStoryUrl: 'https://notion.so/' + storyPage.id.replace(/-/g, '')
    });

  } catch (err) {
    console.error('Ingestion error:', err.message);
    res.status(500).json({ error: err.message });
  }
});



// ── MRL Employer List (for employer order picker) ─────────────────────────

app.get('/api/mrl-employers', async function(req, res) {
  try {
    var NOTION_TOKEN = process.env.NOTION_TOKEN;
    var rows = await queryLibSection('Business header', 50, NOTION_TOKEN);
    // Deduplicate by employer, keep rows that have an employer set
    var seen = {};
    var employers = [];
    rows.forEach(function(r) {
      if (r.employer && !seen[r.employer]) {
        seen[r.employer] = true;
        employers.push({ employer: r.employer, headerText: r.text || '' });
      }
    });
    res.json({ employers: employers });
  } catch (err) {
    console.error('MRL employers error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Job Search (for Resume Assembly picker) ────────────────────────────────

app.post('/api/search-jobs', async function(req, res) {
  try {
    var jobTitle     = (req.body.jobTitle || req.body.companyName || '').trim();
    if (!jobTitle) return res.status(400).json({ error: 'jobTitle required' });
    var NOTION_TOKEN = process.env.NOTION_TOKEN;

    // Query Jobs DB — no filter or sort to avoid invalid_request_url;
    // filter client-side by company name
    // Use v2022-06-28 for direct DB query (v2025-09-03 returns invalid_request_url)
    var r = await notionQueryRequest(JOBS_DB, {
      filter: { property: 'Job Title 1', title: { contains: jobTitle } },
      sorts:  [{ property: 'Date Evaluated', direction: 'descending' }],
      page_size: 50
    }, NOTION_TOKEN);

    var nameLower = jobTitle.toLowerCase();
    var pages = (r.results || []);

    var jobs = pages.map(function(page) {
      var jp = page.properties;
      function jTxt(field) {
        var f = jp[field];
        if (!f) return '';
        if (f.rich_text && f.rich_text[0]) return f.rich_text[0].plain_text;
        if (f.title     && f.title[0])     return f.title[0].plain_text;
        return '';
      }
      return {
        id:        page.id,
        jobTitle:  jTxt('Job Title 1'),
        company:   jTxt('Company Name (Text)'),
        score:     jp[F.m7Score]   && jp[F.m7Score].number   != null ? jp[F.m7Score].number   : null,
        tier:      jp[F.finalTier] && jp[F.finalTier].select         ? jp[F.finalTier].select.name : '',
        status:    jp['Status']    && jp['Status'].status            ? jp['Status'].status.name    : '',
        dateEval:  jp['Date Evaluated'] && jp['Date Evaluated'].date ? jp['Date Evaluated'].date.start : '',
        notionUrl: 'https://notion.so/' + page.id.replace(/-/g, '')
      };
    });

    if (jobs.length === 0) {
      return res.status(404).json({ error: 'No analyzed jobs found for "' + jobTitle + '". Run the Job Posting Analyzer first, then retry.' });
    }

    res.json({ ok: true, jobs });
  } catch (err) {
    console.error('search-jobs error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Resume Assembly Engine ─────────────────────────────────────────────────

async function queryLibSection(sectionName, limit, token) {
  var r = await notionQueryRequest(RESUME_LIB, {
    filter: { property: 'Section', select: { equals: sectionName } },
    sorts: [{ property: 'Rank', direction: 'ascending' }],
    page_size: limit || 10
  }, token);
  return (r.results || []).map(function(p) {
    var pr = p.properties;
    function txt(field) {
      var f = pr[field];
      if (!f) return '';
      if (f.rich_text && f.rich_text[0]) return f.rich_text[0].plain_text;
      if (f.title   && f.title[0])      return f.title[0].plain_text;
      return '';
    }
    return {
      module:     txt('Module'),
      text:       txt('Text'),
      longVer:    txt('Long Version'),
      keywords:   txt('Keywords'),
      employer:   pr['Employer']    && pr['Employer'].select    ? pr['Employer'].select.name    : '',
      bulletType: pr['Bullet Type'] && pr['Bullet Type'].select ? pr['Bullet Type'].select.name : '',
      jobFamily:  (pr['Job Family'] && pr['Job Family'].multi_select || []).map(function(s){ return s.name; }),
      rank:       pr['Rank'] && pr['Rank'].number != null ? pr['Rank'].number : null
    };
  });
}

app.post('/api/assemble-resume', async function(req, res) {
  try {
    var notionJobId        = req.body.notionJobId;
    var companyName        = req.body.companyName || '';
    var resumeTypeOverride = req.body.resumeTypeOverride || '';
    var employerOrder      = Array.isArray(req.body.employerOrder) ? req.body.employerOrder : [];
    if (!notionJobId) return res.status(400).json({ error: 'notionJobId required' });

    var NOTION_TOKEN  = process.env.NOTION_TOKEN;
    var ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

    // 1 — Fetch the specific job record by page ID
    var job = await notionRequest('GET', '/pages/' + notionJobId, null, NOTION_TOKEN);
    if (!job || !job.properties) {
      return res.status(404).json({ error: 'Job record not found. Make sure the analyzer has run for this posting.' });
    }
    var jp  = job.properties;
    function jTxt(field) {
      var f = jp[field];
      if (!f) return '';
      if (f.rich_text && f.rich_text[0]) return f.rich_text[0].plain_text;
      if (f.title     && f.title[0])     return f.title[0].plain_text;
      return '';
    }

    var jobTitle    = jTxt('Job Title 1');
    var postingText = (jTxt('Full Posting') || jTxt('Posting Raw')).slice(0, 3000);
    var m1Keywords  = (jTxt(F.m1Cleaned) || jTxt(F.m1Raw)).slice(0, 600);
    var whyItFits   = jTxt(F.finalWhyItFits).slice(0, 500);
    var m7Score     = jp[F.m7Score]    && jp[F.m7Score].number    != null ? jp[F.m7Score].number    : null;
    var finalTier   = jp[F.finalTier]  && jp[F.finalTier].select         ? jp[F.finalTier].select.name : '';
    var roleType    = jp['Role Type']  && jp['Role Type'].select          ? jp['Role Type'].select.name : '';

    // 2 — Load Resume Library modules in parallel (read path uses database ID)
    var sections = await Promise.all([
      queryLibSection('Headline',                              6,  NOTION_TOKEN),
      queryLibSection('Summary',                              4,  NOTION_TOKEN),
      queryLibSection('Skills',                               4,  NOTION_TOKEN),
      queryLibSection('Core Competencies',                   16,  NOTION_TOKEN),
      queryLibSection('Experience Bullet',                   30,  NOTION_TOKEN),
      queryLibSection('Tools & AI Stack',                     4,  NOTION_TOKEN),
      queryLibSection('PROFESSIONAL DEVELOPMENT & EDUCATION', 4,  NOTION_TOKEN),
      queryLibSection('Business header',                     20,  NOTION_TOKEN),
      queryLibSection('Business description',                10,  NOTION_TOKEN)
    ]);
    var headlines  = sections[0];
    var summaries  = sections[1];
    var skillsMods = sections[2];
    var compMods   = sections[3];
    var bullets    = sections[4];
    var toolsMods  = sections[5];
    var pdMods     = sections[6];
    // Use user-selected employer order from the picker.
    // Only employers in employerOrder appear in the resume, in that sequence.
    // Fallback: if no order sent, include all headers that have an employer set.
    var bizHeaders;
    if (employerOrder.length > 0) {
      bizHeaders = sections[7]
        .filter(function(h){ return employerOrder.indexOf(h.employer) >= 0; })
        .sort(function(a,b){ return employerOrder.indexOf(a.employer) - employerOrder.indexOf(b.employer); });
    } else {
      bizHeaders = sections[7].filter(function(h){ return !!h.employer; });
    }
    var bizDescs   = sections[8];

    function fmtMods(arr) {
      return arr.map(function(m, i) {
        var label = (i + 1) + '.';
        if (m.employer)   label += ' [' + m.employer + ']';
        if (m.bulletType) label += ' [' + m.bulletType + ']';
        if (m.rank)       label += ' [R:' + m.rank + ']';
        var body = (m.text || m.longVer || m.module || '').slice(0, 350);
        return label + ' ' + body;
      }).join('\n');
    }

    // 3 — Single Claude call: type detection + tailoring + assembly
    var prompt =
      'You are a professional resume assembly engine following SOP v3.6 guidelines.\n\n' +
      'JOB DETAILS:\n' +
      'Title: ' + jobTitle + '\n' +
      'Company: ' + companyName + '\n' +
      'Role Type: ' + roleType + '\n' +
      'Hybrid Score: ' + (m7Score != null ? m7Score : 'N/A') + '\n' +
      'Tier: ' + (finalTier || 'N/A') + '\n' +
      'Keywords from posting:\n' + m1Keywords + '\n' +
      'Why It Fits:\n' + whyItFits + '\n' +
      'Posting excerpt:\n' + postingText + '\n\n' +
      'RESUME LIBRARY MODULES:\n\n' +
      'HEADLINES (pick 1 — do NOT modify):\n' + fmtMods(headlines) + '\n\n' +
      'SUMMARIES (pick 1 — tailor by injecting job keywords while preserving voice):\n' + fmtMods(summaries) + '\n\n' +
      'SKILLS (pick 1 — tailor by injecting keyword-matched skills from the posting):\n' + fmtMods(skillsMods) + '\n\n' +
      'CORE COMPETENCY POOL (pick 12, arrange in 3 rows of 4, prioritize posting keyword matches):\n' + fmtMods(compMods) + '\n\n' +
      'EXPERIENCE BULLETS (pick 8–12 most relevant — copy text EXACTLY, never modify a single word):\n' + fmtMods(bullets) + '\n\n' +
      'BUSINESS HEADERS — these are the ONLY employers to include, already in display order (index 1 appears first on the resume). You MUST output selectedBullets grouped by employer in this exact numbered order. Do not include bullets for any employer not listed here.\n' +
      (bizHeaders.length ? bizHeaders.map(function(h,i){ return (i+1)+'. Employer="'+h.employer+'" Header: '+h.text; }).join('\n') : '(none in library yet)') + '\n\n' +
      'TOOLS & AI STACK (pick 1 — tailor lightly to match posting tools):\n' + fmtMods(toolsMods) + '\n\n' +
      'PROFESSIONAL DEVELOPMENT (pick 1):\n' + fmtMods(pdMods) + '\n\n' +
      'RESUME TYPE OPTIONS:\n' +
      '- Product Operations: platform delivery, product roadmap governance, GTM partnership\n' +
      '- Delivery Operations / Implementation: cross-system delivery, integration scale, client onboarding\n' +
      '- Systems Leadership: team building, governance, enterprise architecture, org design\n' +
      '- Zero-to-One / Founder: building in ambiguity, founding-team energy, 0-to-1 ownership\n' +
      '- Hybrid: blends two focuses for cross-functional or hybrid roles\n\n' +
      (resumeTypeOverride ? 'USER OVERRIDE: Force resume type = "' + resumeTypeOverride + '".\n\n' : '') +
      'SOP v3.6 TAILORING RULES — TOP HALF ONLY (experience is never modified):\n' +
      '• Sub-headline: inject identity keywords from job posting — format: "Title | Specialty Area"\n' +
      '• Summary: inject functional + domain keywords while preserving the candidate\'s voice\n' +
      '• Skills: inject skills keywords found in the posting\n' +
      '• Tools & AI Stack: inject tools/platform keywords from the posting\n' +
      '• Core Competencies: select 12 from pool, arrange to best surface posting keyword matches\n' +
      '• Experience bullets: COPY EXACTLY AS STORED — never rewrite, paraphrase, or keyword-stuff\n' +
      '• DATE RULE — CRITICAL: All date ranges must be reproduced exactly as stored — expand abbreviations (Jan→January) but never change year or month. If a date is in the future, copy it anyway.\n' +
      '• BUSINESS HEADER RULE: Populate businessHeaders with each employer whose bullets you selected. Key = employer name exactly, Value = verbatim Business Header text from the list above. Never invent or modify header text. Output selectedBullets with bullets grouped by employer, in the same order as the numbered Business Headers list above (employer #1 first).\n\n' +
      'Return ONLY valid JSON (no markdown fences):\n' +
      '{\n' +
      '  "resumeType": "...",\n' +
      '  "resumeTypeRationale": "...",\n' +
      '  "jobFamily": "...",\n' +
      '  "headline": "...",\n' +
      '  "subHeadline": "...",\n' +
      '  "summary": "...",\n' +
      '  "skills": ["...", "..."],\n' +
      '  "competencies": { "row1": ["","","",""], "row2": ["","","",""], "row3": ["","","",""] },\n' +
      '  "selectedBullets": [ { "text": "...", "employer": "...", "bulletType": "..." } ],\n' +
      '  "businessHeaders": { "ExactEmployerName": "verbatim header text" },\n' +
  '  "toolsStack": "...",\n' +
  '  "professionalDevelopment": "...",\n' +
  '  "keywordsInjected": ["...", "..."],\n' +
  '  "tailoringNotes": "..."\n' +
  '}';

    var aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 6000, messages: [{ role: 'user', content: prompt }] })
    });
    if (!aiRes.ok) throw new Error('Claude API: ' + await aiRes.text());
    var aiData   = await aiRes.json();
    var rawText  = aiData.content[0].text.trim();
    var jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Claude returned no JSON block');
    var assembled = JSON.parse(jsonMatch[0]);

    res.json({ ok: true, jobTitle, companyName, m7Score, finalTier, assembled });

  } catch (err) {
    console.error('Assembly error:', err);
    res.status(500).json({ error: err.message });
  }
});

var PORT = process.env.PORT || 3000;

app.listen(PORT, function() {
  console.log('CIP server running on port ' + PORT);
});
