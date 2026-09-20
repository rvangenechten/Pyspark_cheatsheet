# Research brief: the automated clipping market (September 2026)

## What "automated clipping" means commercially

One long video (podcast episode, stream VOD, webinar, sermon, conference talk)
goes in; a batch of vertical, captioned 20-60 second clips comes out. The
technology is commoditised. The money is not in the cutting — it is in who
owns the distribution problem.

## The tool layer is a price war, and it is being won by nobody

| Tool | Entry price | Metering | Note |
|---|---|---|---|
| OpusClip | ~$15/mo | 1 credit per **minute of source** | A 60-min podcast costs 60 credits |
| Ssemble | lower effective | 1 credit per **video** (≤20 min) | Same episode ≈ 3 credits |
| Choppity | $12/mo (40 exports), $29 unlimited | per export | |
| 2short.ai | $9.90/mo | | budget entry |
| Munch | ~$49/mo | | positioned on trend/campaign analytics |

The category leader sits at **4.0/5 on Trustpilot with 22% one-star reviews**,
and the complaint pattern is consistent: processing failures, credit mechanics
that are not obvious at purchase, and hard cancellation.

**Read:** price is collapsing, trust is low, and per-minute credit metering is
actively resented by exactly the customers who have the most footage. Building
another clipping SaaS means entering a knife fight with no knife.

## The tech is free

Mature open-source pipelines already do what the paid tools do — ClipFree,
OpenShorts, AI-Youtube-Shorts-Generator, AutoClip, opensource-clipping. They
share one stack: **yt-dlp → Whisper/faster-whisper → LLM or heuristic moment
detection → FFmpeg reframe + burned captions**.

Free compute that runs it: Google Colab (15-30 h/week of T4), Kaggle (30 h/week,
often P100), GitHub Actions (free and unlimited for public repos; 2,000 Linux
min/month on private). faster-whisper `small` on CPU transcribes a 60-minute
episode in roughly 8-15 minutes on 4 cores, which is fine for overnight batches.

**Read:** the cost of production is approximately zero. Any margin you earn is
margin on judgement, distribution and reliability — not on compute.

## Two live business models

### Model A — pay-per-view clipping (Whop Content Rewards and similar)

A brand or creator funds a pool and posts a rate per 1,000 verified views. You
clip their content, post it on your own accounts, and get paid per 1,000 views
until the pool empties.

- Rates run **$0.20-$6 per 1,000 views, averaging around $1**; premium briefs
  have been reported from $0.50 up to $25.
- Realistic earnings: **beginners $100-$500/mo, active $500-$2,000, top
  operators $3,000-$8,000+**.
- Budgets are **first-come-first-served** and most clips never cross the
  minimum view threshold to earn anything at all.

**Read:** genuinely $0 to enter, and the campaign brief is what gives you a
licence to use the footage — which is the only clean rights position in
repost-style clipping. But it is a lottery with a saturated player base, your
income disappears when a pool empties, and you build no asset.

### Model B — done-for-you clipping service (recommended)

You clip **your client's own footage** under a contract, they post it on
**their own** channels.

- Retainers run **$1,250-$25,000/mo**, with most B2B buyers at **$3,000-$8,000**.
  Sub-$3K/mo is where agency margins break and quality slips by month two.
- Per-clip pricing runs $5-$800 depending on scope; campaigns $5,000-$40,000.
- Smaller operators legitimately run at **$300-$1,500/mo** per client.
- Documented small case: 1.19M views → $1,290 MRR.
- The verticals that reliably buy are the ones producing long-form **on a
  schedule** and hating the edit: **weekly podcasters, streamers sitting on VOD,
  and churches with a sermon every Sunday and no editor.**

**Read:** boring, unsexy, and it is where the money actually is. Rights are
clean by construction. Revenue is recurring. Specialising in one vertical lets
you quote against a known outcome instead of competing per clip.

## The rights problem, stated plainly

Reposting someone else's video without permission infringes copyright.
Fair use is not a blanket exception — it leans on commentary, criticism and
transformation, and a straight repost with captions slapped on is weakly
positioned. Platforms run Content ID on every upload; a strike can cost the
account. The safe positions are: **footage you own**, **footage licensed to you
in writing** (a client contract or a funded campaign brief), or public
domain/Creative Commons.

Model B is safe by construction. Model A is safe only within a funded campaign's
stated terms.

## Conclusion

Sell the service, not the software. Use the free pipeline as internal leverage
so one operator delivers what an agency staffs three editors for. Use Model A
campaigns as a paid training ground and a portfolio source while Model B
retainers ramp.

## Sources

- [12 Best Opus Clip Alternatives for 2026 — Choppity](https://www.choppity.com/blog/best-opus-clip-alternatives/)
- [11 Best AI Clipping Tools in 2026: Honest Comparison with Real Pricing — Ssemble](https://www.ssemble.com/blog/best-ai-clipping-tools-2026)
- [Opus Clip Review 2026: Pricing, Pros, Cons — Ssemble](https://www.ssemble.com/blog/opus-clip-review-2026)
- [7 Best Opus Clip Alternatives (Free & Paid) in 2026 — Ssemble](https://www.ssemble.com/blog/opus-clip-alternative-free-2026)
- [Whop Clipping: $0.20 to $6 per 1,000 Views (2026) — OpenClip](https://openclip.app/guides/whop-clipping-guide)
- [How much do clippers actually earn in 2026 — StreamClipping AI](https://streamclipping.ai/blog/how-much-do-clippers-earn)
- [What Is a Clipping Marketplace? — Overlap](https://www.overlap.ai/blogs/what-is-a-clipping-marketplace-how-creators-podcasters-and-live-streamers-are-getting-paid-to-go-viral)
- [Podcast Clipping Agency Pricing 2026: $3K Floor, $300K Ceiling — FORKOFF](https://forkoff.xyz/blog/clipping/podcast-clipping-agency-pricing)
- [Podcast Clipping Revenue: 1.19M Views, $1,290 MRR Case Study — FORKOFF](https://forkoff.xyz/blog/clipping/podcast-clipping-revenue-case-study)
- [How to Start a Clipping Business in 2026 — ClipSpeed](https://www.clipspeed.ai/blog/how-to-start-clipping-business-2025.html)
- [AI Clipping Agency: 2026 Pricing, Margins & Tool Stack — ClipSpeed](https://www.clipspeed.ai/use-cases/clipping-agency.html)
- [Short-Form Compliance & Rights: Music, Clips, and Fair Use — OpusClip](https://www.opus.pro/blog/short-form-compliance-rights)
- [TikTok Copyright Rules for Creators (2026) — Soundstripe](https://www.soundstripe.com/blogs/tiktok-copyright)
- [GitHub Actions Pricing 2026: Free Tier, Per-Minute Rates](https://cicdcalculator.com/github-actions)
- [Free GPU access in 2026: real options and limits](https://electronics.alibaba.com/question/free-gpu-access-in-2026-real-options-limits)
- Open-source pipelines: [ClipFree](https://github.com/johnwangui374-bot/ClipFree), [OpenShorts](https://github.com/mutonby/openshorts), [AI-Youtube-Shorts-Generator](https://github.com/Anil-matcha/AI-Youtube-Shorts-Generator), [AutoClip](https://github.com/artbyjazi/autoclip), [opensource-clipping](https://github.com/NaufalRizqullah/opensource-clipping)
