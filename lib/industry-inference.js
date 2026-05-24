/**
 * industry-inference.js — name-pattern → industry classifier.
 *
 * Pure function. No I/O. Used by:
 *   - emb-quote-ai.js: annotate lookup_customer responses with inferred industry
 *   - aggregate-industry-lookalikes.js: bucket every NWCA customer by industry
 *   - any future tool that wants vertical-aware behavior
 *
 * Approach: layered keyword matching, ranked by specificity. The first match
 * with confidence='high' wins; otherwise the highest-confidence partial match.
 * If nothing matches → {industry: 'Unknown'} (caller can fall back to web
 * classification via classify_company_via_web tool).
 *
 * Calibration: keywords were chosen from NWCA's real customer roster
 * (10 years of EMB sales export — Erik confirmed common verticals).
 *
 * Created 2026-05-24 — EMB Smart A4.
 */

'use strict';

// Industry definitions — order matters within an industry block (higher-confidence
// keywords first). The matcher walks each industry in priority order and returns
// the first hit. "high" confidence = keyword is unambiguous; "medium" = could
// arguably fit elsewhere but usually correct.
const INDUSTRIES = [
    // ===== Public Safety (highly specific, do first) =====
    {
        industry: 'Public Safety',
        patterns: [
            { kw: /\bfire\s+(department|dept\.?|district|rescue|prevention|protection|station|engine|chief|fighter|fighting)\b/i, confidence: 'high' },
            { kw: /\b(police|sheriff|deputy|marshal|trooper|patrol|swat|k-?9)\b/i, confidence: 'high' },
            { kw: /\b(EMT|EMS|paramedic|ambulance|rescue\s+squad|first\s+responder)\b/i, confidence: 'high' },
            { kw: /\bcorrections|jail|prison|detention\s+(center|facility)\b/i, confidence: 'high' },
            { kw: /\b(law\s+enforcement|public\s+safety)\b/i, confidence: 'high' },
            { kw: /\bsecurity\s+(services|group|forces|company)\b/i, confidence: 'medium' },
        ],
    },

    // ===== Education =====
    {
        industry: 'Education',
        patterns: [
            { kw: /\b(elementary|middle|high)\s+schools?\b/i, confidence: 'high' },
            { kw: /\b(public\s+schools?|private\s+schools?|independent\s+schools?)\b/i, confidence: 'high' },
            { kw: /\b(school\s+district|school\s+board|usd\s+\d+)\b/i, confidence: 'high' },
            { kw: /\b(academy|preparatory|prep\s+school|charter\s+school|montessori)\b/i, confidence: 'high' },
            { kw: /\b(university|college|community\s+college|institute\s+of\s+technology)\b/i, confidence: 'high' },
            { kw: /\b\w+\s+(HS|MS|ES|JHS|JR\.?\s+HIGH|SR\.?\s+HIGH)\b/, confidence: 'high' },
            { kw: /\b(student|teacher|education|educational|academic|campus|tutor)\b/i, confidence: 'medium' },
            { kw: /\b(daycare|preschool|early\s+learning|child\s+care)\b/i, confidence: 'medium' },
        ],
    },

    // ===== Healthcare =====
    {
        industry: 'Healthcare',
        patterns: [
            { kw: /\b(hospital|medical\s+center|health\s+(system|center|clinic)|urgent\s+care)\b/i, confidence: 'high' },
            { kw: /\b(clinic|surgery\s+center|pharmacy|dental|dentistry|orthodontics)\b/i, confidence: 'high' },
            { kw: /\b(physician|doctor|nursing|chiropractic|optometry|veterinary|vet\b)/i, confidence: 'high' },
            { kw: /\b(home\s+health|hospice|rehab|rehabilitation|wellness)\b/i, confidence: 'medium' },
            { kw: /\b(orthopaedic|orthopedic|cardiology|pediatric|psychiatric|behavioral\s+health)\b/i, confidence: 'high' },
            { kw: /\bmedical\b(?!\s+(arts|terminology))/i, confidence: 'medium' },
        ],
    },

    // ===== Construction — Electrical =====
    {
        industry: 'Construction/Electrical',
        patterns: [
            { kw: /\belectric(al)?\s+(co|company|contractor|service|services|inc|llc|corp)\b/i, confidence: 'high' },
            { kw: /\b(electrical|electricians?)\b/i, confidence: 'high' },
            { kw: /\b(low\s+voltage|low-voltage|voltage|wiring|lineman|powerline)\b/i, confidence: 'medium' },
            { kw: /\bsolar\s+(power|installation|installers)\b/i, confidence: 'medium' },
        ],
    },

    // ===== Construction — Trades =====
    {
        industry: 'Construction/Trades',
        patterns: [
            { kw: /\b(plumbing|plumber|plumbers)\b/i, confidence: 'high' },
            { kw: /\b(HVAC|heating\s+and\s+cooling|heating\s+&\s+cooling|air\s+conditioning|refrigeration)\b/i, confidence: 'high' },
            { kw: /\b(mechanical\s+(contractor|services|systems)|sheet\s+metal)\b/i, confidence: 'high' },
            { kw: /\b(welding|fabrication|fabricators|millwright)\b/i, confidence: 'high' },
            { kw: /\b(painting|painters?)\s+(co|company|contractor|services|inc|llc)\b/i, confidence: 'high' },
            { kw: /\b(flooring|carpentry|carpenter|drywall|insulation|stucco)\b/i, confidence: 'medium' },
            { kw: /\b(landscaping|landscape|tree\s+service|arborist|excavation)\b/i, confidence: 'high' },
        ],
    },

    // ===== Construction — General =====
    {
        industry: 'Construction',
        patterns: [
            { kw: /\b(construction|contractors?|builders?|building\s+co|home\s+builder)\b/i, confidence: 'high' },
            { kw: /\b(roofing|roof|siding|gutters?)\b/i, confidence: 'high' },
            { kw: /\b(concrete|masonry|paving|asphalt|earthworks|excavating)\b/i, confidence: 'high' },
            { kw: /\b(general\s+contractor|gc\s+(services|inc|llc)|design[-\s]build)\b/i, confidence: 'high' },
            { kw: /\b(crane|rigging|scaffolding|demolition)\b/i, confidence: 'medium' },
            { kw: /\bdevelopment(s)?\s+(co|company|llc|inc|group)\b/i, confidence: 'medium' },
        ],
    },

    // ===== Hospitality =====
    {
        industry: 'Hospitality',
        patterns: [
            { kw: /\b(restaurant|cafe|café|coffee|bistro|diner|steakhouse|grill)\b/i, confidence: 'high' },
            { kw: /\b(catering|caterers?)\b/i, confidence: 'high' },
            { kw: /\b(brewery|brewing|brew\s+pub|brewpub|distillery|winery|vineyard|taphouse|tap\s+house)\b/i, confidence: 'high' },
            { kw: /\b(hotel|motel|inn|lodge|resort|hospitality)\b/i, confidence: 'high' },
            { kw: /\b(bar\s*&\s*grill|pub|tavern|lounge)\b/i, confidence: 'high' },
            { kw: /\b(bakery|deli|pizzeria|sushi|food\s+truck)\b/i, confidence: 'medium' },
        ],
    },

    // ===== Religious =====
    {
        industry: 'Religious',
        patterns: [
            { kw: /\b(church|ministry|ministries|parish|cathedral|chapel|fellowship|congregation)\b/i, confidence: 'high' },
            { kw: /\b(synagogue|temple|mosque|diocese|presbytery)\b/i, confidence: 'high' },
            { kw: /\b(christian|baptist|methodist|lutheran|catholic|orthodox|evangelical|pentecostal)\s+(church|center|school|fellowship)\b/i, confidence: 'high' },
            { kw: /\b(youth\s+ministry|kids\s+ministry|missions?|outreach)\b/i, confidence: 'medium' },
        ],
    },

    // ===== Professional Services =====
    {
        industry: 'Professional Services',
        patterns: [
            { kw: /\b(law\s+(firm|offices?|group)|attorneys?|attorneys\s+at\s+law|legal\s+services)\b/i, confidence: 'high' },
            { kw: /\b(CPA|accounting|accountants?|tax\s+(services?|preparation))\b/i, confidence: 'high' },
            { kw: /\b(financial\s+(services?|advisors?|planning|group)|wealth\s+management|investment\s+(group|advisors?))\b/i, confidence: 'high' },
            { kw: /\b(bank|credit\s+union|savings\s+bank|federal\s+credit)\b/i, confidence: 'high' },
            { kw: /\b(insurance|insurers?|underwriters?)\b/i, confidence: 'high' },
            { kw: /\b(consulting|consultants?)\b/i, confidence: 'medium' },
            { kw: /\b(real\s+estate|realty|realtors?|property\s+(management|group))\b/i, confidence: 'high' },
            { kw: /\b(architecture|architects?|engineering\s+(firm|group|services|inc|llc|corp)|engineers?\s+(inc|llc|corp|group|associates)|engineers\b)/i, confidence: 'high' },
        ],
    },

    // ===== Manufacturing =====
    // NOTE: do NOT match standalone "industries"/"industrial" — Tavily snippets
    // are full of "primary industry is...", "Industrial Service Solutions" etc
    // which would over-classify everything as Manufacturing.
    {
        industry: 'Manufacturing',
        patterns: [
            { kw: /\b(manufacturer|manufacturing\s+(co|company|inc|llc|corp|plant|facility|services?))\b/i, confidence: 'high' },
            { kw: /\b(machining|machine\s+shop|tool\s+&\s+die|tooling)\b/i, confidence: 'high' },
            { kw: /\b(foundry|forge|smelting|metal\s+works|metalworking)\b/i, confidence: 'high' },
            { kw: /\b(plastics?|polymer|composites?|injection\s+molding|extrusion)\b/i, confidence: 'high' },
            { kw: /\b(\w+\s+(industries|mfg)\b|industries\s+(inc|llc|corp))\b/i, confidence: 'medium' },
            { kw: /\b(processing|packaging|production\s+(co|inc|llc))\b/i, confidence: 'medium' },
        ],
    },

    // ===== Logistics / Transportation =====
    {
        industry: 'Logistics/Transportation',
        patterns: [
            { kw: /\b(trucking|freight|logistics|distribution|shipping|courier)\b/i, confidence: 'high' },
            { kw: /\b(transport(ation)?\s+(services?|co|inc|llc|group)|hauling|cartage)\b/i, confidence: 'high' },
            { kw: /\b(express|delivery\s+services?|fleet\s+services)\b/i, confidence: 'medium' },
        ],
    },

    // ===== Retail / Wholesale =====
    {
        industry: 'Retail',
        patterns: [
            { kw: /\b(wholesale|wholesaler|warehouse\s+club|membership\s+(club|store)|big\s+box|department\s+store)\b/i, confidence: 'high' },
            { kw: /\b(hardware\s+store|home\s+improvement|building\s+materials|lumber|lumberyard)\b/i, confidence: 'high' },
            { kw: /\b(boutique|retail\s+(store|chain|shop)|mercantile|outfitters?|outlet\s+(mall|store)|grocery|supermarket)\b/i, confidence: 'high' },
            { kw: /\b(automotive\s+(group|sales|dealership)|auto\s+(sales|dealer)|chevrolet|ford|toyota|honda|harley[-\s]?davidson)\b/i, confidence: 'high' },
            { kw: /\b(supply\s+(co|company|store|inc|llc)|farm\s+supply|feed\s+store)\b/i, confidence: 'medium' },
            { kw: /\b(boutique|store|shop|retail)\b/i, confidence: 'medium' },
        ],
    },

    // ===== Government / Municipal =====
    {
        industry: 'Government',
        patterns: [
            { kw: /\b(city\s+of\s+|county\s+of\s+|town\s+of\s+|borough\s+of\s+|village\s+of\s+)/i, confidence: 'high' },
            { kw: /\b(municipal|public\s+works|department\s+of\s+|state\s+of\s+|federal\s+agency)/i, confidence: 'high' },
            { kw: /\b(parks?\s+(and|&)\s+(rec|recreation)|water\s+(district|department|utility)|utility\s+district)\b/i, confidence: 'high' },
            { kw: /\b(transit\s+(authority|agency)|public\s+transit|metro\s+transit|port\s+authority)\b/i, confidence: 'high' },
            { kw: /\b(US\s+(navy|army|marines|air\s+force|coast\s+guard)|military|naval|ROTC|national\s+guard)\b/i, confidence: 'high' },
        ],
    },

    // ===== Energy / Utilities =====
    {
        industry: 'Energy/Utilities',
        patterns: [
            { kw: /\b(power\s+(generation|company|group|services|systems|propulsion)|electric\s+(utility|cooperative))\b/i, confidence: 'high' },
            { kw: /\b(natural\s+gas|gas\s+company|propane\s+(co|company|services)|petroleum|oil\s+(&|and)\s+gas)\b/i, confidence: 'high' },
            { kw: /\b(energy\s+(company|services|solutions|group)|renewable\s+energy|wind\s+(farm|energy)|hydroelectric)\b/i, confidence: 'high' },
            { kw: /\b(public\s+utility|utility\s+services?|utilities\s+(co|inc|llc))\b/i, confidence: 'high' },
        ],
    },

    // ===== Non-profit =====
    {
        industry: 'Non-profit',
        patterns: [
            { kw: /\b(non[-\s]?profit|nonprofit|501\s*\(?c\)?|foundation\s+(inc|group|of)|charity|charitable)\b/i, confidence: 'high' },
            { kw: /\b(YMCA|YWCA|United\s+Way|Habitat\s+for\s+Humanity|Salvation\s+Army|Goodwill)\b/i, confidence: 'high' },
            { kw: /\b(food\s+bank|shelter|crisis\s+center|domestic\s+violence)\b/i, confidence: 'high' },
        ],
    },

    // ===== Agriculture =====
    {
        industry: 'Agriculture',
        patterns: [
            { kw: /\b(farm|farms|farming|ranch|orchards?|vineyard|nursery|gardens?)\b/i, confidence: 'high' },
            { kw: /\b(agriculture|agricultural|agronomy|crop\s+(services|management))\b/i, confidence: 'high' },
            { kw: /\b(dairy|cattle|livestock|poultry|swine)\b/i, confidence: 'high' },
        ],
    },

    // ===== Sports / Recreation =====
    {
        industry: 'Sports/Recreation',
        patterns: [
            { kw: /\b(athletic\s+(club|association|director)|sports?\s+(club|league|complex)|gym|fitness)\b/i, confidence: 'high' },
            { kw: /\b(soccer|baseball|softball|basketball|football|hockey|lacrosse|volleyball|wrestling|track|swim)\s+(club|team|league|academy|association)\b/i, confidence: 'high' },
            { kw: /\b(golf\s+(club|course|academy)|ski\s+(resort|patrol)|yacht\s+club|equestrian)\b/i, confidence: 'high' },
            { kw: /\b(YMCA|recreation\s+center|community\s+center|crossfit)\b/i, confidence: 'medium' },
        ],
    },
];

/**
 * inferIndustry(companyName) → { industry, confidence, signal }
 *
 * @param {string} companyName — raw company name as stored in the CRM.
 * @returns {{industry: string, confidence: 'high'|'medium'|'unknown', signal: string|null}}
 *
 *   industry:   the matched industry (or 'Unknown')
 *   confidence: 'high' = unambiguous keyword match
 *               'medium' = partial / could fit elsewhere
 *               'unknown' = no pattern matched
 *   signal:     the substring that triggered the match (for debugging /
 *               showing to the rep so they can override). null when Unknown.
 */
function inferIndustry(companyName) {
    const name = String(companyName || '').trim();
    if (!name) {
        return { industry: 'Unknown', confidence: 'unknown', signal: null };
    }

    let bestMatch = null;

    for (const def of INDUSTRIES) {
        for (const pattern of def.patterns) {
            const match = name.match(pattern.kw);
            if (!match) continue;
            // Stop on first high-confidence hit (priority is by industry order)
            if (pattern.confidence === 'high') {
                return {
                    industry: def.industry,
                    confidence: 'high',
                    signal: match[0],
                };
            }
            // Track best medium match in case nothing high hits
            if (!bestMatch) {
                bestMatch = {
                    industry: def.industry,
                    confidence: pattern.confidence,
                    signal: match[0],
                };
            }
        }
    }

    if (bestMatch) return bestMatch;
    return { industry: 'Unknown', confidence: 'unknown', signal: null };
}

// Industry list — exposed so callers can enumerate (e.g. the aggregation
// script needs to know all valid bucket names).
const ALL_INDUSTRIES = INDUSTRIES.map(i => i.industry).concat(['Unknown']);

module.exports = { inferIndustry, ALL_INDUSTRIES };
