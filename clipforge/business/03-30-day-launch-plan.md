# 30-day launch plan

Every step costs $0. Steps marked **[gate]** must be finished before moving on —
they are the ones people skip and then wonder why nothing converts.

## Week 1 — make the product real (days 1-7)

**Day 1-2: get the pipeline running on your own machine.**
```bash
# ffmpeg must exist and must be built with libass
ffmpeg -filters | grep ass

cd clipforge
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# pull a public episode you are allowed to process (see legal doc)
yt-dlp -f "bv*[height<=1080]+ba/b" -o episode.mp4 "<URL>"
python -m clipforge episode.mp4 -o clips/ -n 8
```

**Day 3: [gate] watch all 8 clips on a phone, muted.**
If fewer than 3 are ones you would publish, do not proceed to outreach. Tune:
open `clips.json`, look at the `components` breakdown for the clips you
rejected, and adjust `WEIGHTS` in `clipforge/score.py`. Add hook patterns you
see working in your niche to `HOOK_PATTERNS`. Re-run. This loop is the product.

**Day 4: pick your vertical and name it out loud.**
Not "podcasters". "Clips for B2B SaaS podcasts." Write it at the top of a file
and do not change it for 30 days.

**Day 5: build the prospect list — 40 shows.**
Sources: Apple Podcasts category charts, Listen Notes search, YouTube "podcast"
+ your industry, LinkedIn "host of" in the headline. Record: show name, host
name, episode cadence, whether they already post clips, where they post, and
the single best episode to audit.

Disqualify: shows that already post good clips daily (they have an editor),
shows dormant 60+ days, shows with no visible business behind them.

**Day 6-7: produce 3 portfolio clips from 3 different shows on your list.**
These are your free audits for the first three prospects, and your website
content. Post them on your own account so the link is live.

## Week 2 — first contact (days 8-14)

**Day 8: put up the site.** `clipforge/site/index.html` is ready. Push the repo,
turn on GitHub Pages, done. It costs nothing and it only needs to do one job:
prove you can do the work. Replace the placeholder clip embeds with your three.

**Day 9: [gate] send 10 audits.** Not pitches — audits. Attach the three clips
you cut *from their own episode*. Template in `04-outreach-templates.md`.

**Day 10-14: 10 more audits per day. 50 sent by day 14.**
Track in a free spreadsheet: sent, opened, replied, called, closed. Expect
15-25% reply rate on a real audit with real clips attached, vs 1-3% on a cold
pitch with none. If you are under 10%, your clips are the problem, not your
copy — go back to day 3.

## Week 3 — convert (days 15-21)

**The call is 20 minutes and has four questions:**
1. What are you hoping short-form does for the business? (*Lead gen? Audience?
   If they cannot answer, they will churn — price them at Starter.*)
2. Who posts today, and what happens when they are busy? (*Finds the real pain.*)
3. If we shipped 5 clips a week for 90 days, what would make that obviously
   worth it? (*They define success. Write it down verbatim and quote it back
   in the proposal.*)
4. What is the budget range you had in mind? (*Ask plainly. Never guess low.*)

**Then:** name the price on the call. $750 Starter, $1,500 Growth, recommend
Growth. Send the one-page proposal the same day — anything longer loses.

**Day 21 target: first client signed.**

## Week 4 — deliver and systematise (days 22-30)

**Day 22: onboarding, 30 minutes.**
- Signed agreement (`05-legal-and-rights.md`) — **[gate]**, never start without it
- Shared Drive folder: they drop episodes, you drop clips
- Brand pass: their font, their caption colour, their safe-area margins
  (`--font`, `--font-size`, `highlight` in `captions.py`)
- Agreed weekly delivery day

**Day 23-28: ship the first batch within 48 hours of the first episode.**
The first delivery sets the relationship. Over-deliver once: send 2 extra clips
with a note on which you would post first and why.

**Day 29: ask for the referral.** After a good first batch, not at month three:
*"Who else in [industry] is sitting on episodes nobody clips?"*

**Day 30: write down the three things that were slow this month.**
Fix them in the pipeline, not in your calendar. That is the whole compounding
mechanism of this business.

## The free-tier stack

| Need | Free tool |
|---|---|
| Compute | Your machine / Colab (15-30 h/wk T4) / Kaggle (30 h/wk) |
| Site | GitHub Pages |
| Files | Google Drive 15GB |
| Invoicing | Wave (free), or Stripe (per-transaction only) |
| Scheduling calls | Cal.com free tier |
| CRM | Google Sheets |
| Contracts | Template here + free e-sign tier |

## What to ignore for 30 days

Logo design. LLC formation (register once you have revenue and a reason —
in most places you can invoice as a sole trader from day one; check your
jurisdiction). A custom video editor UI. Building your own SaaS. Posting about
starting the business instead of starting it.
