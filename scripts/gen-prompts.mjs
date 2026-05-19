/**
 * Generate prompts.json — 1000 deterministic prompts for load testing.
 * ~80% source-triggering (so results carry `sources`), ca-heavy country mix.
 *   node scripts/gen-prompts.mjs [--seed=N] [--count=N] [--out=path]
 */
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);
const SEED = Number(args.seed ?? 1);
const COUNT = Number(args.count ?? 1000);
const OUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  args.out ?? 'prompts.json',
);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const weighted = (pairs) => {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [v, w] of pairs) {
    r -= w;
    if (r <= 0) return v;
  }
  return pairs[pairs.length - 1][0];
};

const COUNTRIES = [
  ['ca', 60],
  ['us', 15],
  ['gb', 8],
  ['au', 5],
  ['de', 4],
  ['fr', 3],
  ['jp', 3],
  ['br', 2],
];

const subjects = {
  mountain: ['Mount Everest', 'K2', 'Denali', 'Kilimanjaro', 'Mont Blanc', 'Mount Fuji', 'Aconcagua', 'Mount Elbrus', 'Matterhorn', 'Mount Rainier', 'Annapurna', 'Mount Logan'],
  city: ['Tokyo', 'Toronto', 'Berlin', 'São Paulo', 'Mumbai', 'Lagos', 'Sydney', 'Seoul', 'Mexico City', 'Cairo', 'Istanbul', 'Buenos Aires', 'Vancouver', 'Montréal', 'Reykjavík'],
  country: ['Canada', 'Japan', 'Brazil', 'Germany', 'Australia', 'Kenya', 'Norway', 'Vietnam', 'Egypt', 'Peru', 'Iceland', 'New Zealand', 'Portugal', 'Argentina'],
  league: ['Formula 1', 'the Premier League', 'the NBA', 'the NHL', 'MLB', 'the Olympics', 'the FIFA World Cup', 'the Tour de France', 'the US Open tennis', 'the UFC', 'the Cricket World Cup', 'the Ryder Cup'],
  company: ['SpaceX', 'OpenAI', 'Anthropic', 'Nvidia', 'TSMC', 'Boeing', 'Toyota', 'Samsung', 'Stripe', 'Shopify', 'Hugging Face', 'Mistral AI', 'Tesla', 'Apple'],
  person: ['Marie Curie', 'Albert Einstein', 'Stephen Hawking', 'Charles Darwin', 'Isaac Newton', 'Richard Feynman', 'Ada Lovelace', 'Alan Turing', 'Nikola Tesla', 'Rosalind Franklin', 'Carl Sagan', 'Katherine Johnson'],
  food: ['ramen', 'sushi', 'poutine', 'pad thai', 'feijoada', 'biryani', 'ceviche', 'paella', 'tagine', 'pho', 'jollof rice', 'butter chicken', 'tacos al pastor'],
  topic: ['quantum computing', 'fusion energy', 'lab-grown meat', 'CRISPR gene editing', 'large language models', 'reusable rockets', 'desalination', 'solid-state batteries', 'mRNA vaccines', 'autonomous driving'],
  event: ['the Apollo 11 mission', 'the fall of the Berlin Wall', 'the discovery of penicillin', 'the moon landing', 'the invention of the transistor', 'the first heart transplant', 'the Manhattan Project'],
  animal: ['blue whale', 'snow leopard', 'axolotl', 'platypus', 'orca', 'giant panda', 'narwhal', 'komodo dragon', 'kakapo', 'manatee'],
};

const sourceTemplates = [
  ['What are the latest news about ${company}?', 'company'],
  ['Find recent articles on ${topic}.', 'topic'],
  ['Who currently leads ${league}?', 'league'],
  ['What is happening with ${company} this week?', 'company'],
  ['List recent developments in ${topic}.', 'topic'],
  ['Give me sources on ${person}.', 'person'],
  ['Find the official website for ${company}.', 'company'],
  ['What did ${company} announce recently?', 'company'],
  ['Latest scores from ${league}.', 'league'],
  ['Current status of ${topic} research.', 'topic'],
  ['What papers were published about ${topic} in 2026?', 'topic'],
  ['Summarize the latest reporting on ${event}.', 'event'],
  ['What controversies surround ${company} this year?', 'company'],
  ['Find expert opinions on ${topic}.', 'topic'],
  ['Recent statistics on tourism in ${country}.', 'country'],
  ['Show me reviews of ${food} restaurants in ${city}.', 'food', 'city'],
  ['What is the current population of ${city}?', 'city'],
  ['What is the weather forecast for ${city} this week?', 'city'],
  ['Who is the current head of government of ${country}?', 'country'],
  ['Find a recent biography source for ${person}.', 'person'],
  ['What new movies or shows feature ${person}?', 'person'],
  ['Cite a 2026 article about ${topic}.', 'topic'],
  ['Latest standings in ${league}.', 'league'],
  ['Recent breakthroughs in ${topic}.', 'topic'],
  ['Find news from ${city} this month.', 'city'],
  ['Who summited ${mountain} most recently?', 'mountain'],
  ['What are the entry requirements for tourists to ${country}?', 'country'],
  ['What is the current ticker price for ${company} stock?', 'company'],
  ['Find a recipe source for traditional ${food}.', 'food'],
  ['Recent conservation news about the ${animal}.', 'animal'],
  ['What is trending in ${city} right now?', 'city'],
  ['Latest research on the ${animal}.', 'animal'],
];

const factTemplates = [
  ['Name one ${mountain-class}.', null],
  ['Give one famous ${person-class}.', null],
  ['What is the tallest ${mountain-class} in the world?', null],
  ['Name a country in ${continent}.', 'continent'],
  ['What ocean borders ${country} to the east?', 'country'],
  ['What language is most spoken in ${country}?', 'country'],
  ['What continent is ${city} on?', 'city'],
  ['Roughly how tall is ${mountain}?', 'mountain'],
  ['What does ${animal} primarily eat?', 'animal'],
  ['Name a dish that uses ${food}.', 'food'],
  ['What field is ${person} known for?', 'person'],
  ['In one sentence, what is ${topic}?', 'topic'],
  ['Was ${event} in the 20th century?', 'event'],
  ['What sport is played in ${league}?', 'league'],
  ['What is the capital of ${country}?', 'country'],
];

const continents = ['Africa', 'Asia', 'Europe', 'South America', 'Oceania'];

function fill(tpl, keys) {
  let out = tpl;
  // Special class-only placeholders (no subject lookup, just a literal word)
  out = out.replace('${mountain-class}', 'mountain').replace('${person-class}', 'scientist');
  for (const k of keys) {
    if (!k) continue;
    if (k === 'continent') {
      out = out.replace('${continent}', pick(continents));
      continue;
    }
    out = out.replace('${' + k + '}', pick(subjects[k]));
  }
  return out;
}

function genOne() {
  const wantSource = rand() < 0.8;
  const [tpl, ...keys] = pick(wantSource ? sourceTemplates : factTemplates);
  const prompt = fill(tpl, keys);
  const country = weighted(COUNTRIES);
  const markdown = rand() < 0.2;
  const html = rand() < 0.05;
  return { prompt, country, markdown, html };
}

const prompts = Array.from({ length: COUNT }, genOne);

// Fisher–Yates shuffle so country distribution is interleaved.
for (let i = prompts.length - 1; i > 0; i -= 1) {
  const j = Math.floor(rand() * (i + 1));
  [prompts[i], prompts[j]] = [prompts[j], prompts[i]];
}

writeFileSync(OUT, JSON.stringify(prompts, null, 2) + '\n');
const byCountry = prompts.reduce((m, p) => ((m[p.country] = (m[p.country] ?? 0) + 1), m), {});
console.log(`wrote ${prompts.length} prompts → ${OUT}`);
console.log('country mix:', byCountry);
console.log('markdown=true:', prompts.filter((p) => p.markdown).length);
console.log('html=true:', prompts.filter((p) => p.html).length);
