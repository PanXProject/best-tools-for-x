import { createClient } from '@supabase/supabase-js';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter.js';
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore.js';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import matter from 'gray-matter';
import { existsSync } from 'fs';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(isSameOrAfter);
dayjs.extend(isSameOrBefore);

const TIMEZONE = 'UTC';
const TOOLS_DIR = 'src/content/tools';
const AR_TOOLS_DIR = 'src/content/tools/ar';

const AWARD_TYPE = process.env.AWARD_TYPE || 'daily';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  {
    auth: { persistSession: false, autoRefreshToken: false }
  }
);

async function getToolUpvotes() {
  const { data: pages, error } = await supabase.from('pages').select('id, total_upvotes');
  if (error) throw error;

  const tools = [];

  for (const page of pages) {
    const id = page.id.replace(/^tool?\//, '');
    let publishDate;

    // Try English MDX
    try {
      const englishMdxPath = join(TOOLS_DIR, `${id}.mdx`);
      const content = await readFile(englishMdxPath, 'utf-8');
      const { data } = matter(content);
      publishDate = data.publishDate;
      tools.push({ ...page, id, publishDate });
      continue;
    } catch {}

    // Try Arabic MDX if English fails
    try {
      const arabicMdxPath = join(AR_TOOLS_DIR, `${id}.mdx`);
      const content = await readFile(arabicMdxPath, 'utf-8');
      const { data } = matter(content);
      publishDate = data.publishDate;
      tools.push({ ...page, id, publishDate });
    } catch {}
  }

  return tools;
}

function getPeriodDates(periodType, now) {
  switch (periodType) {
    case 'daily': {
      const previousDay = now.subtract(1, 'day');
      return {
        start: previousDay.startOf('day'),
        end: previousDay.endOf('day'),
        awardDate: previousDay.format('YYYY-MM-DD')
      };
    }
    case 'weekly': {
      const previousWeek = now.subtract(1, 'week');
      return {
        start: previousWeek.startOf('week'),
        end: previousWeek.endOf('week'),
        awardDate: previousWeek.endOf('week').format('YYYY-MM-DD')
      };
    }
    case 'monthly': {
      const previousMonth = now.subtract(1, 'month');
      return {
        start: previousMonth.startOf('month'),
        end: previousMonth.endOf('month'),
        awardDate: previousMonth.endOf('month').format('YYYY-MM-DD')
      };
    }
    case 'yearly': {
      const previousYear = now.subtract(1, 'year');
      return {
        start: previousYear.startOf('year'),
        end: previousYear.endOf('year'),
        awardDate: previousYear.endOf('year').format('YYYY-MM-DD')
      };
    }
  }
}

async function determineWinners(tools, periodType, now) {
  const { start, end, awardDate } = getPeriodDates(periodType, now);

  // Filter tools published in the period and with >0 upvotes
  const eligibleTools = tools.filter(tool => {
    const publishDate = dayjs(tool.publishDate).tz(TIMEZONE);
    return publishDate.isSameOrAfter(start) && publishDate.isSameOrBefore(end) && tool.total_upvotes > 0;
  });

  // Sort descending by upvotes
  eligibleTools.sort((a, b) => b.total_upvotes - a.total_upvotes);

  // Get unique upvote counts
  const uniqueUpvotes = [...new Set(eligibleTools.map(t => t.total_upvotes))];

  const winners = [];

  uniqueUpvotes.forEach((upvoteCount, index) => {
    if (index >= 3) return; // Only top 3 ranks

    const rank = index + 1;
    const toolsWithUpvotes = eligibleTools.filter(t => t.total_upvotes === upvoteCount);

    toolsWithUpvotes.forEach(tool => {
      winners.push({
        slug: tool.id,
        total_upvotes: tool.total_upvotes,
        rank,
        awardDate
      });
    });
  });

  return winners;
}

async function updateToolMdx(toolPath, newAward) {
  const content = await readFile(toolPath, 'utf-8');
  const { data, content: body } = matter(content);

  const existingAwards = data.awards || [];

  if (!existingAwards.includes(newAward)) {
    const updatedData = { ...data, awards: [...existingAwards, newAward] };
    const updatedContent = matter.stringify(body, updatedData);
    await writeFile(toolPath, updatedContent);
  }
}

async function main() {
  const now = dayjs().tz(TIMEZONE);
  const tools = await getToolUpvotes();

  const winners = await determineWinners(tools, AWARD_TYPE, now);

  for (const winner of winners) {
    const awardId = `${AWARD_TYPE}-award-${winner.rank}-${winner.awardDate}`;

    const englishMdxPath = join(TOOLS_DIR, `${winner.slug}.mdx`);
    const arabicMdxPath = join(AR_TOOLS_DIR, `${winner.slug}.mdx`);

    if (existsSync(englishMdxPath)) await updateToolMdx(englishMdxPath, awardId);
    if (existsSync(arabicMdxPath)) await updateToolMdx(arabicMdxPath, awardId);
  }

  console.log(`Successfully updated ${AWARD_TYPE} awards.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
