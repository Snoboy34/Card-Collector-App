function parseAttributes(fullText) {
  const cardNumbers = new Set();
  const rawNumberMatches = [];

  // Match isolated small tokens on short or contextual lines
  const isolatedDigitRegex = /\b(\d{1,4})\b/g;
  
  // Premium attributes matching rules
  const premiumKeywords = { 
    auto: [/bauto(?:graph|graphed)s?\b/i, /bautograph\b/i, /bautographed\b/i], 
    patch: [/bpatch\b/i, /bpatches\b/i], 
    refractor: [/brefractor\b/i, /brefractors\b/i], 
    prizm: [/bprizm\b/i, /bprizms\b/i], 
    oneOfOne: [/\b1\s*\/\s*1\b/, /\b1\s+of\s+1\b/, /\b1of1\b/ ] 
  };
  
  const premium = { auto: false, autograph: false, patch: false, refractor: false, prizm: false, oneOfOne: false }; 
  
  for (const key of Object.keys(premiumKeywords)) { 
    for (const pat of premiumKeywords[key]) { 
      if (pat.test(fullText)) { 
        premium[key] = true; 
        break; 
      } 
    } 
  }

  return { 
    years: [], 
    cardNumbers: Array.from(cardNumbers), 
    premium, 
    rawMatches: { yearMatches: [], numberMatches: rawNumberMatches } 
  };
}

module.exports = { parseAttributes };