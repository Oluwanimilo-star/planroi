import raw from '../data/plans.json';
export const slug = s => s.toLowerCase().replace(/\+/g,'-plus').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
export const verified = raw.verified_on;
export const notVerified = raw.not_verified;
export const plans = raw.plans.map(p => ({...p, slug: slug(p.provider+' '+p.plan), pslug: slug(p.provider)}));
export const providers = [...new Set(plans.map(p=>p.provider))].map(n=>({name:n, slug:slug(n), plans:plans.filter(p=>p.provider===n)}));
export const CODING = ['ChatGPT Plus (incl. Codex)','ChatGPT Pro (3 tiers)','Claude Pro','Claude Max 5x','Claude Max 20x','Plus','Premium','Super','Ultra','Copilot Pro','Copilot Pro+','Copilot Max'];
export function price(p){
  const v=p.price_usd_month;
  if (Array.isArray(v)) return v.map(x=>'$'+x).join(' / ')+' /mo';
  if (v===null||v===undefined) return p.price_cad_month ? 'USD not published (CA$'+p.price_cad_month.join(' / CA$')+')' : 'Not published';
  return v===0 ? 'Free' : '$'+v+'/mo'+(p.price_annual_equiv?` ($${p.price_annual_equiv}/mo billed annually)`:'');
}
