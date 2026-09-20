# Rights, copyright and a contract template

> **Not legal advice.** This is a practical summary and a starting-point
> template written by a non-lawyer. Rules differ by country. Before a deal
> above ~$5K/mo, or any deal involving music licensing or a named brand, have
> a lawyer in your jurisdiction review the agreement.

## The rule that governs this whole business

You may only cut clips from footage where **one of these is true**:

1. **You own it.** Your own recordings.
2. **It is licensed to you in writing.** A signed client agreement, or a funded
   pay-per-view campaign brief whose stated terms permit it.
3. **It is public domain or under a licence that permits it** (check the
   specific Creative Commons variant — `NC` forbids commercial use, `ND`
   forbids derivatives, and a clip is a derivative).

Anything else is infringement. Reposting someone's video without permission is
not cured by adding captions or by crediting them. Fair use is a defence, not a
permission slip: it leans on commentary, criticism, education and genuine
transformation, and a straight repost is weakly positioned. Platforms run
Content ID on every upload; a strike can take the account with it.

**The service business in this repo is clean by construction** — you only ever
touch footage a client has licensed to you in writing.

## Where the traps are

| Trap | What to do |
|---|---|
| **Guests.** The host owns the episode, but a guest may not have signed anything permitting commercial reuse of their likeness. | Clause 4 below makes the client warrant they hold releases. Ask to see the guest agreement for high-profile guests. |
| **Music.** Background music in the source is licensed for the podcast, not necessarily for a TikTok. Adding a trending sound is a separate licence question again. | Strip or duck source music in clips where you can. Use the platform's own in-app audio library — that licence covers you on that platform only. |
| **B-roll and screen shares.** Third-party footage inside the episode carries its own rights. | Do not clip over screen shares of other people's products, films or sports. |
| **Client's own claims.** A client making medical, financial or legal claims in a clip can create liability that lands on the account posting it. | If you post on their accounts, add clause 7. If they post, it is their problem. |
| **Campaign clipping (Model A).** Terms vary wildly per campaign. | Read each brief. Save a copy. If it does not explicitly grant use of the footage, do not clip it. |

## Client agreement — template

> **CLIP PRODUCTION AGREEMENT**
>
> Between **[Your name / business]** ("Provider") and **[Client]** ("Client"),
> effective **[date]**.
>
> **1. Services.** Provider will produce **[N]** short-form vertical video clips
> per month from long-form source material supplied by Client, including
> transcription, selection, vertical reframing, burned-in captions, and
> suggested post copy. Delivery within **[48 hours / 5 business days]** of
> Client supplying each source file.
>
> **2. Fees.** **$[amount] per month**, invoiced on the **[1st]** of each month,
> payable within **[7] days**. Month-to-month. Either party may terminate with
> **14 days'** written notice. Fees already paid for the current month are not
> refunded; Provider will deliver that month's remaining clips.
>
> **3. Licence to Provider.** Client grants Provider a non-exclusive,
> royalty-free licence to access, copy, transcribe, edit and excerpt the
> supplied source material **for the sole purpose of producing clips under this
> Agreement**. This licence ends on termination, except that Provider may
> retain and display delivered clips in its portfolio (see clause 8).
>
> **4. Client warranties.** Client warrants that it owns or has secured all
> rights necessary in the source material, **including releases from any guests,
> performers or third parties appearing in it, and licences for any music or
> third-party footage contained in it**, sufficient to permit the production and
> publication of clips. Client will indemnify Provider against any claim arising
> from a breach of this warranty.
>
> **5. Ownership of deliverables.** On payment of the relevant invoice, all
> rights in the delivered clips transfer to Client. Provider retains no claim
> over them beyond clause 8.
>
> **6. Revisions.** Client may request re-cuts of up to **[20]%** of each
> month's clips at no additional charge, within 7 days of delivery. Additional
> revisions are billed at **$[rate]/hour**.
>
> **7. Publication.** [*Use only if Provider posts on Client's accounts:*]
> Where Provider publishes clips to Client's accounts, Client remains solely
> responsible for the accuracy and legality of the statements made in the source
> material, and for compliance with each platform's terms. Provider will follow
> Client's written posting schedule and will not publish anything Client has
> flagged for review.
>
> **8. Portfolio rights.** Provider may display delivered clips and name Client
> as a client in its portfolio and marketing, unless Client objects in writing.
>
> **9. No performance guarantee.** Provider does not guarantee views,
> engagement, follower growth or any commercial outcome. Platform distribution
> is outside either party's control. Fees are for production and delivery of
> clips, not for results.
>
> **10. Confidentiality.** Provider will not disclose unpublished source
> material or any non-public information in it.
>
> **11. Liability.** Each party's total liability under this Agreement is
> limited to the fees paid in the **three months** preceding the claim. Neither
> party is liable for indirect or consequential loss.
>
> **12. Governing law.** **[Your jurisdiction]**.
>
> Signed: ______________________ (Provider)  Date: __________
> Signed: ______________________ (Client)    Date: __________

Clause 9 is the one that protects the business. Never promise views — the
platforms change distribution monthly and a written guarantee you cannot
control is the fastest route to a refund demand you cannot refuse.

## Data handling

Unreleased episodes are confidential material. Keep client source files in a
per-client folder, delete source footage 30 days after delivery, do not feed
unreleased audio to a third-party API that trains on inputs — the default
pipeline here transcribes locally, which sidesteps the question entirely. If
you enable `score.llm_rerank`, note that it sends **transcript text of the
shortlisted moments** to the model provider; tell clients, or leave it off.

## A note on Model A (pay-per-view clipping)

If you also run campaign clipping for income while retainers ramp:

- Save a dated copy of each campaign brief. It is your licence.
- Stay inside the brief: platforms named, edits permitted, disclosure required.
- Disclose paid promotion where the platform or your local advertising rules
  require it. In many jurisdictions a paid clip is an ad regardless of format.
- Never run bought views. It voids payment and usually the account.
