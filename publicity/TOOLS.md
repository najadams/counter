# TOOLS.md

> The publicity tooling stack for Protocol & Transfer Advisory (PTA).
> Companion to `SEO.md` and `MARKETING.md`. One recommendation per workflow — no buffet of options.

---

## 0. Operating principle

Every tool below was picked against one test: **does it protect or fight the PTA brand system** (charcoal/gold, Cormorant Garamond + DM Sans + DM Mono, zero radius, zero emoji, zero purple)?

Tools that nudge toward generic templates, rounded corners, stock illustrations, or playful gradients are rejected — even when popular — because you spend more energy fighting their defaults than producing work. The whole stack is built around **owning the brand once, then reusing it everywhere**.

Total monthly cost of this stack: **$0–$32/month** depending on optional add-ons.

---

## 1. The core stack

| Workflow | Tool | Cost | Why |
|----------|------|------|-----|
| Design (everything visual) | **Figma** | Free | Brand system already lives there. Multi-page carousels, banners, OG images, document PDFs — one tool, one source of truth. |
| Writing (drafts, edits) | **Claude** + plain text editor | Existing | You have Claude. Drafting in Markdown keeps content version-controllable in the repo. |
| Scheduling + analytics | **Buffer** (free tier) | Free | 10 scheduled posts per channel, 3 channels free. Covers Naj + partner + company page exactly. |
| Video recording | **Phone (4K) + lavalier mic** | ~$30 one-off | A $30 Boya BY-M1 lavalier plus an iPhone in 4K, shot in natural window light, beats 90% of "professional" LinkedIn video. |
| Video editing | **Descript** (free tier) | Free / $16 paid | Transcript-based editing — cut filler words by deleting text. Auto-subtitles. The fastest way to produce LinkedIn video that exists. |
| Outreach tracking | **Supabase table** (or Google Sheet) | Free | Single source of truth: prospect, company, role, sent date, opened, replied, outcome. Sheet is fine for first 6 months. |
| Metrics dashboard | **Google Sheet** | Free | The four KPIs in §7 of `MARKETING.md` do not need a tool. They need a spreadsheet and discipline. |

---

## 2. Workflow 1 — writing and scheduling posts (3x/week per partner)

**Stack:** Markdown in repo → Claude review pass → Buffer schedule.

1. Draft the post in a `marketing/posts/YYYY-MM-DD-slug.md` file. Front-matter with author, pillar, format, target publish time.
2. Hand the draft to Claude with the brief: "Tighten this to <250 words. Cut hedging. Keep the regulatory citation precise. Remove any emoji or hot-take phrasing." (See `MARKETING.md` §3.1 for the structural template.)
3. Read it aloud once. If a sentence trips your tongue, it's wrong.
4. Paste into Buffer. Schedule for Tue/Wed/Thu morning per `MARKETING.md` §2.
5. Move the file to `marketing/posts/published/` once live, with the LinkedIn URL appended to front-matter.

**Why this and not a dedicated tool:** Taplio, Shield, and Typefully are $30–80/month for content suggestions and analytics. At PTA's volume (5 posts/week across two accounts) and brand discipline (substance comes from the lawyer partner, not an AI), they're paying for features that fight the strategy. Buffer free + Claude does the job.

**Avoid:** ChatGPT's default voice. It introduces emoji, "Here's the thing," and "🚀" by default — all banned. Claude with a strict system prompt is markedly better at maintaining PTA's tone. Even better: train Claude on three of your best-written existing posts as exemplars before each drafting session.

---

## 3. Workflow 2 — carousels (2x/month minimum)

**Stack:** Figma → export as PDF → upload as LinkedIn document.

1. In Figma, build the **six carousel slide templates** from `linkedin-post-templates.html` once. Save as a shared library. Naming convention: `pta/carousel/cover`, `pta/carousel/premise`, `pta/carousel/point`, `pta/carousel/statute`, `pta/carousel/summary`, `pta/carousel/cta`.
2. For each new carousel, duplicate the template file, swap copy, swap numerals.
3. Export `File → Export → PDF (multi-page)`. Pages must be 1080×1350.
4. Upload to LinkedIn via "Add a document" — *not* as separate image posts. Document carousels get materially more reach.

**Build time after the first carousel:** ~45 minutes for a 10-slide deck.

**Avoid:** Canva. Yes it has carousel templates. No it cannot resist nudging you toward rounded corners, sans-serif headlines, and stock illustrations. PTA's brand fights Canva's defaults at every step. Figma's blank canvas is friendlier when the brand is already designed.

**Avoid:** Carousel-specific tools like AuthoredUp, Postdrips, Hypefury Studio. They charge $20–40/month to do what a $0 Figma file does once you've built the templates.

---

## 4. Workflow 3 — document PDFs (1x/month)

**Stack:** Figma → PDF, OR Markdown → Pandoc → branded LaTeX template → PDF.

Two valid paths depending on length:

**2–4 pages, image-heavy → Figma.** Same workflow as carousels but in landscape A4.

**4+ pages, text-heavy → code it.** Write the document in Markdown. Use Pandoc with a LaTeX template that loads Cormorant Garamond and DM Sans, charcoal/gold colours, hairline rules. One-time setup, then `pandoc draft.md -o output.pdf --template=pta.tex` for every future document. This is more your speed and version-controllable in the repo.

I can build the LaTeX template when you need the first long-form document. Until then, Figma works.

---

## 5. Workflow 4 — video (1x every 2–3 weeks)

**Stack:** iPhone 4K + Boya BY-M1 + window light → Descript → upload native to LinkedIn.

1. Shoot in 4K vertical (9:16) for LinkedIn-native video. Set the phone on a tripod or stack of books at eye level. North-facing window light is free and beats most ring lights.
2. Wear lavalier. Phone microphones are the single biggest difference between amateur and acceptable LinkedIn video. The Boya is $30 and plug-and-play.
3. Record 90–120 seconds. Don't script word-for-word — outline three beats and talk to them.
4. Drop the file into Descript. Delete filler words by literally selecting the text "um," "you know," "so basically" and pressing delete. Trim the start and end the same way.
5. Add subtitles (Descript auto-generates). Style: DM Sans, white text, charcoal background bar, bottom-third.
6. Add a 3-second branded lower-third on first appearance: partner name + "Managing Partner, Protocol & Transfer Advisory."
7. Export 1080×1920 MP4. Upload native to LinkedIn — never YouTube link, never Vimeo embed.

**Avoid:** Hiring a videographer for the first 10 videos. The brand needs to be consistent and frequent first. Bring in production help once the format is proven.

**The AI avatar alternative:** If shooting real video is the blocker for the lawyer partner, Higgsfield Soul Character trained on his real photos can substitute — but only after you've trained on 10–15 high-quality, well-lit photos of him. Treat it as a fallback for weeks when scheduling kills a real shoot, not the default.

---

## 6. Workflow 5 — outreach and tracking

**Stack:** Zoho Mail (already configured) + Supabase table + manual sends.

PTA's outreach volume — ~10 emails per partner per fortnight per `MARKETING.md` §5.1 — does not justify Lemlist, Apollo, Smartlead, or any other sequencing tool. Those are built for 100+ sends a day and they trash sender reputation when you don't have the volume to feed them. They also push you toward template-heavy outreach, which is exactly the opposite of the insight-hook approach.

**Table schema** (drop straight into Supabase):

```sql
create table marketing.outreach (
  id uuid primary key default gen_random_uuid(),
  sent_at timestamptz not null default now(),
  author text not null,                  -- naj | partner
  prospect_name text not null,
  company text not null,
  role text not null,
  channel text not null,                 -- email | linkedin_dm | linkedin_inmail
  insight_hook text not null,            -- the specific observation in the first line
  opened boolean default false,
  replied boolean default false,
  replied_at timestamptz,
  meeting_booked boolean default false,
  outcome text,                          -- engaged | retainer | declined | no_response
  notes text
);
```

**Open tracking:** Zoho doesn't track opens by default. Two options — (a) live without open-tracking (cleanest, no tracking pixels signalling "this is automated"), or (b) use a single Mailtrack-style extension. For premium advisory outreach, **skip the tracking pixels**. They get caught by enterprise mail filters and signal "salesperson" — wrong frame for the relationship you want.

---

## 7. Headshots and photography

Worth a one-time investment: **hire a local Accra photographer for one 90-minute session.** Get 6–8 shots of each partner in PTA brand-context wardrobe (charcoal, dark navy, white) against neutral backgrounds. Variations: looking at camera, three-quarter, standing, seated, hands-visible-talking. Cost: GHS 1,500–3,000 (~$120–250) total.

These images carry the LinkedIn banners, the website team page, document PDF bios, and OG images for years. Highest leverage spend in the whole stack.

**Avoid:** AI-generated headshots. The buyer's first instinct is "is this person real" — synthetic faces, even excellent ones, undercut premium advisory positioning at exactly the wrong moment.

---

## 8. Image generation — where it does and doesn't fit

A short, honest accounting.

| Use case | Verdict | Notes |
|----------|---------|-------|
| Partner headshots | **No** | Real photographer. Always. |
| Abstract brand imagery (compass motifs, geometric patterns) | **Maybe** | Midjourney or Nano Banana 2 via Higgsfield for atmospheric stills. Coded SVG in Figma is usually cleaner. |
| LinkedIn carousel imagery | **No** | The brand system uses typography and rules, not imagery. Don't introduce a new visual language. |
| Document PDF imagery | **Rarely** | Charts and tables only. No decorative AI imagery. |
| Marketing video b-roll | **Maybe** | If you do produce video and need a cutaway, generated b-roll of an abstract Accra skyline or a regulation document close-up can work. Flag risk: Meta/LinkedIn AI-content detection. |

**General rule:** PTA's brand is built on restraint, not imagery. The more imagery you add, the more it dilutes the type-and-rule visual signature. Use imagery only when the alternative is worse.

---

## 9. Tools we evaluated and rejected

| Tool | Why rejected |
|------|--------------|
| Vibiz.ai | Built for DTC/SaaS funnels, Meta/TikTok ads, auto-generated brand identity. Wrong channel, wrong category, would overwrite the existing brand system. |
| Canva | Defaults fight the PTA brand. Possible but inefficient. |
| Taplio / Shield / AuthoredUp | $30–80/month for features the strategy doesn't need at PTA's volume. |
| Hypefury, Typefully | Built for Twitter/threads. LinkedIn support is secondary. |
| HubSpot CRM (full) | Heavy for ~50 prospects. Supabase table or Sheet is enough. |
| Lemlist / Smartlead / Apollo | Outreach volume too low to justify. Pushes toward templated outreach — wrong frame for premium advisory. |
| Mailchimp / Beehiiv | No newsletter yet. Revisit at month 6. |
| Loom (for video) | Designed for screen-share, not face-to-camera. Descript is better for talking-head editing. |
| Veed / Submagic | Subtitle-only tools. Descript already does this plus the editing. |
| Notion (for content calendar) | Use the repo. `marketing/posts/` is the calendar. |

---

## 10. The total stack at a glance

```
$0      — Figma (design)
$0      — Buffer free tier (scheduling, 3 channels)
$0      — Descript free tier (video editing, 1 hour/month — upgrade to $16/mo if needed)
$0      — Supabase (already in stack — outreach + metrics tables)
$0      — Claude (already in stack — drafting)
$0      — Zoho Mail (already configured)
$30     — Boya BY-M1 lavalier (one-off)
$200    — Photographer session (one-off, every 12–18 months)
─────────
$0–16/month recurring + ~$230 one-off setup
```

The discipline is more valuable than any tool in this list. Buffer scheduling 5 posts a week, on the calendar, in the brand system, for 12 weeks — that single behaviour beats any premium tool you could buy.
