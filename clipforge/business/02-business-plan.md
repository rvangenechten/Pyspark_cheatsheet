# ClipForge — business plan (zero-cost start)

## The business in one line

A done-for-you short-form clipping service for **one narrow vertical**, where
every clip is cut from footage the client already owns, produced by an
open-source pipeline that costs nothing to run.

## Why this shape

The research brief lays out the numbers. The short version:

- Selling clipping **software** means fighting OpusClip, Ssemble, Choppity and
  2short.ai on price, with the production stack already free on GitHub.
- Selling clipping **labour** means competing with people who charge $5 a clip.
- Selling a **weekly outcome to a vertical that publishes on a schedule** is
  the position where retainers hold and where the free pipeline converts
  directly into margin.

## Pick one vertical

Candidates, ranked by how well they fit a solo start:

| Vertical | Why they buy | Why it works for you |
|---|---|---|
| **B2B podcasts** (SaaS, agency, finance) | Clips are lead-gen, not vanity. Budget lives in marketing. | Highest willingness to pay; $1.5-3K/mo is a rounding error to them |
| **Churches** | Sermon every Sunday, no editor, deeply networked | Referral density is extreme; one happy church introduces five |
| **Streamers** | Hundreds of hours of VOD, zero time | Volume is huge; budgets are thinner and more variable |
| **Coaches / course sellers** | Clips drive funnel entries directly | Fast decisions, but churn is high |

**Recommendation: B2B podcasts, one industry.** Not "podcasts" — *"clips for
B2B SaaS podcasts"*. One industry means one visual template, one hook library,
and referrals that compound because the guests are each other's peers.

## Offer ladder

| Tier | Price | Deliverable | Who it is for |
|---|---|---|---|
| **Audit** | Free | 3 clips from an existing episode, plus a one-page note on what their long-form is wasting | Every prospect. This is the entire sales process. |
| **Starter** | $750/mo | 8 clips/mo (2 per weekly episode), captions, title + caption copy, posting-ready | Solo podcasters testing short-form |
| **Growth** | $1,500/mo | 20 clips/mo, 2 hook variants on the top 4, thumbnail frames, monthly performance readout | The default. Most clients land here. |
| **Scale** | $3,000/mo | 40 clips/mo, multi-platform reformatting, posting on their accounts, quarterly strategy | Teams with an in-house marketer to coordinate with |

Start at $750. Raise to $1,500 as the default after three clients. The market
supports $3-8K/mo for agencies; you get there by narrowing the vertical and
quoting against an outcome, not by adding editing hours.

## Unit economics

Per Growth client, per month:

| Line | Amount |
|---|---|
| Revenue | $1,500 |
| Transcription (faster-whisper, local/Colab) | $0 |
| Rendering (FFmpeg, local) | $0 |
| Hosting/delivery (Google Drive or GitHub Pages) | $0 |
| Optional LLM re-ranking (~1 small call per episode) | <$1 |
| Scheduling, invoicing (free tiers) | $0 |
| **Your time**: ~35 min per episode after setup | ~2.5 h/mo |
| **Gross margin** | **>99%, ~$600/hour of your time** |

The margin is real because the pipeline does the finding, cutting, reframing
and captioning. Your 35 minutes are: review the ranked shortlist, reject the
two that misread the room, tighten three hooks, send.

Capacity: 8-10 Growth clients is roughly 25 h/month of delivery. That is a
$12,000-15,000/mo solo business before you hire an editor.

## What actually costs money (and does not have to yet)

| Thing | Free option | Pay when |
|---|---|---|
| Compute | Your own machine, Colab, Kaggle, GitHub Actions | Rendering blocks your day |
| Domain + site | GitHub Pages on `*.github.io` | After client #2 (~$12/yr) |
| Email | Personal Gmail | Client #3 — a custom domain closes better |
| Contracts | The template in `05-legal-and-rights.md` | Deal size > $5K/mo → get a lawyer to review |
| Scheduling | Manual delivery over Drive | Client #4 |
| Payments | Free invoicing (Wave, Stripe pay-per-transaction) | Immediately — Stripe's fee is per transaction, not upfront |

**Total to first dollar: $0.**

## Defensibility

You will not out-engineer OpusClip and you do not need to. What compounds:

1. **Vertical proof.** "We made 140 clips for 9 fintech podcasts" is not
   replicable by a tool that has never seen a fintech podcast.
2. **The hook library.** Every clip you ship teaches you which openings hold in
   your niche. That goes back into `score.py` as weights and patterns.
3. **Referral density.** Guests on a B2B podcast host their own podcasts.
4. **Switching cost.** After three months you know their back catalogue, their
   pet topics, and which co-host carries a clip. A tool restarts cold each time.

## Risks, honestly

| Risk | Mitigation |
|---|---|
| Clients ask "why not just use OpusClip for $15?" | Answer directly: they can. They will get 30 unsorted clips and post none of them. You sell the selection and the publishing, not the cutting. Show the free audit as evidence. |
| Platform algorithm shift kills short-form reach | Sell **clip production**, never guaranteed views. Retainer terms in `03-pricing-and-offers.md` are outcome-adjacent, not view-guaranteed. |
| One big client is 60% of revenue | Cap at 40%. Refuse the fourth tier upgrade until client #4 exists. |
| Rights dispute over guest footage | Contract clause 4 in `05-legal-and-rights.md`: the client warrants they hold guest releases. Never clip a third party's channel without a written brief. |
| Burnout at 10 clients | The pipeline is the hire. Improve the ranker before you add hours. |

## 90-day targets

| Milestone | Day |
|---|---|
| Pipeline running on a real episode, 3 clips you would publish | 3 |
| 5 free audits sent | 10 |
| First paying client | 21 |
| 3 clients, $2,250+ MRR | 45 |
| Raise default tier to $1,500, first referral closed | 60 |
| 6 clients, $6,000+ MRR | 90 |
