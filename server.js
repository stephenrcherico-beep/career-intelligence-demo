const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const JOBS_DB     = '403582a0e82b4e349c300a084f332ad1';
const COMPANIES_DB = 'b3e93effd284415280a842c6ef5ffc92';
const NOTION_API  = 'https://api.notion.com/v1';

// ─── Notion helpers ────────────────────────────────────────────────────────────

function notionHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Notion-Version': '2022-06-28'
  };
}

// Short rich_text (≤2000 chars)
function rt(text) {
  if (!text) return [];
  return [{ type: 'text', text: { content: String(text).slice(0, 2000) } }];
}

// Long rich_text — splits into 2000-char blocks (up to 10 000 chars total)
function rtLong(text) {
  if (!text) return [];
  const str = String(text);
  const chunks = [];
  for (let i = 0; i < str.length && chunks.length < 5; i += 2000) {
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
  return arr.slice(0, 10).map(n => ({ name: String(n) }));
}

async function notionRequest(method, endpoint, body, token) {
  const res = await fetch(NOTION_API + endpoint, {
    method,
    headers: notionHeaders(token),
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Notion ${method} ${endpoint} → ${res.status}: ${err}`);
  }
  return res.json();
}

// ─── Company helpers ────────────────────────────────────────────────────────────

async function findCompany(companyName, token) {
  const result = await notionRequest('POST', `/databases/${COMPANIES_DB}/query`, {
    filter: {
      property: 'Company',
      title: { contains: String(companyName).slice(0, 50) }
    },
    page_size: 1
  }, token);
  return result.results && result.results.length > 0 ? result.results[0] : null;
}

async function createCompany(data, token) {
  const props = {
    'Company': { title: rt(data.companyName) }
  };
  if (data.companyIndustry)      props['Industry']                  = { rich_text: rt(data.companyIndustry) };
  if (data.companyHeadquarters)  props['Headquarters']              = { rich_text: rt(data.companyHeadquarters) };
  if (data.companyEmployeeCount) props['Employee Count']            = { number: data.companyEmployeeCount };
  if (data.companySummary)       props['Company Summary']           = { rich_text: rt(data.companySummary) };
  if (data.companyPrimaryProduct)props['Primary Product / Platform']= { rich_text: rt(data.companyPrimaryProduct) };
  if (data.companyTechStack)     props['Tech Stack (If Known)']     = { rich_text: rt(data.companyTechStack) };
  if (data.companyType)          props['Company Type']              = { select: sel(data.companyType) };
  if (data.companyWebsite)       props['Website']                   = { url: data.companyWebsite };

  return notionRequest('POST', '/pages', {
    parent: { database_id: COMPANIES_DB },
    properties: props
  }, token);
}

// ─── Job posting helper ─────────────────────────────────────────────────────────

async function createJobPosting(data, postingText, postingUrl, token) {
  const today    = new Date().toISOString().split('T')[0];
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];

  const props = {
    'Job Title 1':                       { title:       rt(data.jobTitle) },
    'Company Name (Text)':               { rich_text:   rt(data.companyName) },
    'Location 1':                        { rich_text:   rt(data.location) },
    'Source Type':                       { select:      { name: 'Job Board' } },
    'Lane':                              { select:      { name: 'Traditional Job Search' } },
    'FINAL — Status':                    { select:      { name: 'Needs Review' } },
    'Next Action':                       { rich_text:   rt('Review & Tailor Resume') },
    'Posting Raw':                       { rich_text:   rtLong(postingText) },
    'Full Posting':                      { rich_text:   rtLong(postingText) },
    'FINAL — Full Posting':              { rich_text:   rtLong(postingText) },
    'Date Evaluated':                    { date:        { start: today } },
    'Next Action Date':                  { date:        { start: tomorrow } },
    'Module 6 — Semantic Summary':       { rich_text:   rt('Semantic scoring unavailable') }
  };

  // Selects — only write if value present
  if (data.seniority)    props['Seniority']         = { select: sel(data.seniority) };
  if (data.roleType)     props['Role Type']          = { select: sel(data.roleType) };
  if (data.industry)     props['Industry']           = { select: sel(data.industry) };
  if (data.finalIndustry)props['FINAL — Industry']  = { select: sel(data.finalIndustry) };
  if (data.finalTier)    props['FINAL — Tier']       = { select: sel(data.finalTier) };
  if (data.fitAssessment)props['Fit Assessment']     = { select: sel(data.fitAssessment) };

  // Numbers
  if (data.matchScore != null)               props['Match Score']                    = { number: data.matchScore };
  if (data.module1KeywordScore != null)      props['Module 1 — Keyword Score']       = { number: data.module1KeywordScore };
  if (data.module2DomainScore != null)       props['Module 2 — Domain Score']        = { number: data.module2DomainScore };
  if (data.module3SkillsMatchScore != null)  props['Module 3 — Skills Match Score']  = { number: data.module3SkillsMatchScore };
  if (data.module4SeniorityScore != null)    props['Module 4 — Seniority Score']     = { number: data.module4SeniorityScore };
  if (data.module5IndustryScore != null)     props['Module 5 — Industry Score']      = { number: data.module5IndustryScore };
  if (data.module7HybridScore != null)       props['Module 7 — Hybrid Score']        = { number: data.module7HybridScore };
  if (data.salaryMin)                        props['Salary Min']                     = { number: data.salaryMin };
  if (data.salaryMax)                        props['Salary Max']                     = { number: data.salaryMax };

  // Long text fields
  if (data.module1KeywordsRaw)      props['Module 1 — Keywords (Raw)']              = { rich_text: rt(data.module1KeywordsRaw) };
  if (data.module1KeywordsCleaned)  props['Module 1 — Keywords (Cleaned)']          = { rich_text: rt(data.module1KeywordsCleaned) };
  if (data.module2DomainSignals)    props['Module 2 — Domain Signals']              = { rich_text: rt(data.module2DomainSignals) };
  if (data.module3RequiredSkills)   props['Module 3 — Required Skills']             = { rich_text: rt(data.module3RequiredSkills) };
  if (data.module4SenioritySignals) props['Module 4 — Seniority Signals']           = { rich_text: rt(data.module4SenioritySignals) };
  if (data.module5IndustrySignals)  props['Module 5 — Industry Signals']            = { rich_text: rt(data.module5IndustrySignals) };
  if (data.module7WeightedSummary)  props['Module 7 — Weighted Summary']            = { rich_text: rt(data.module7WeightedSummary) };
  if (data.module8RecommendedModules) props['Module 8 — Recommended Resume Modules']= { rich_text: rt(data.module8RecommendedModules) };
  if (data.module8MatchSummary)     props['Module 8 — Match Summary (Formatted)']   = { rich_text: rt(data.module8MatchSummary) };
  if (data.finalWhyItFits)          props['FINAL — Why It 
