import rss from '@astrojs/rss'; import ch from '../../data/changes.json';
export const GET = (ctx) => rss({ title:'PlanROI changes', description:'AI subscription plan price and limit changes', site: ctx.site,
 items: ch.changes.map(c=>({ title:`${c.provider} ${c.plan}: ${c.summary}`, pubDate:new Date(c.date), link:'/changes/', description:`${c.before??'—'} → ${c.after}. Source: ${c.source}` })) });
