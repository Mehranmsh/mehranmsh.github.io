# MEHRAN MUSIC AI · Independent Engine

این پروژه در مسیر توسعهٔ فناوری مستقل MEHRAN قرار دارد. در مسیر فعال هیچ موتور آمادهٔ تولید موسیقی، ACE-Step، API خارجی یا سرویس پولی استفاده نمی‌شود.

## وضعیت واقعی فعلی

- هستهٔ مستقل تحلیل اولیهٔ شعر فارسی و ساخت طرح آهنگ در `mehran_music_core.py`
- استخراج تقریبی تعداد هجاها، پایان واژه‌ها و نشانه‌های احساسی شعر
- لایهٔ آوایی محافظه‌کار برای واکه‌های بلندِ نوشته‌شده و حرکت‌های اعرابی؛ تکیهٔ واژگانی را حدس نمی‌زند و واکه‌های کوتاهِ نوشته‌نشده را بازسازی نمی‌کند
- پیشنهاد گام، مُد، تمپو، توالی آکورد، ساختار بخش‌ها و طرح اولیهٔ ملودی
- زمان‌بندی تقریبی عبارت‌ها با توجه به مرز واژه‌ها و نشانه‌های نگارشی؛ این قابلیت جایگزین آوانویسی و تشخیص تکیهٔ واقعی نیست
- خروجی Standard MIDI File پنج‌ترکه: تمپو، ملودی، آکورد، بیس و درام
- بیس مستقل با الگوی پایهٔ ریشه/پنجم و درام مستقل با الگوی ۴/۴ و درام‌کیت General MIDI
- انتخاب وارونگی آکورد با حرکت نرم بین صداها
- کنترل‌پلین محلی Python و SQLite برای نگهداری پروژه‌ها
- بدون API خارجی، دانلود مدل یا fallback پولی
- **نمونهٔ اولیهٔ رندر WAV با سمپل‌های ضبط‌شده پیاده‌سازی شده است.** طرح آهنگ می‌تواند به رویدادهای ملودی، آکورد، بیس و درام تبدیل شود و با فایل‌های WAV موجود در بانک صدا میکس شود. این قابلیت فقط وقتی خروجی می‌دهد که نمونه‌های واقعی و مناسب در بانک محلی فراهم باشند؛ هنوز بانک سازهای کامل و حرفه‌ای همراه پروژه نیست.

## هستهٔ مستقل

ماژول `engine/mehran_music_core.py` فقط از کتابخانهٔ استاندارد Python استفاده می‌کند:

- `analyze_lyrics(lyrics)`: تحلیل اولیهٔ شعر فارسی
- `compose_plan(lyrics, title, genre, target_bpm)`: ساخت نقشهٔ آهنگ شامل گام، مُد، BPM، آکوردها، بخش‌بندی و نت‌های پیشنهادی
- زمان‌بندی نت‌ها از مرز تقریبی واژه‌ها و مکث‌های نشانه‌گذاری‌شده اثر می‌گیرد؛ چون مصوت‌های کوتاه فارسی غالباً نوشته نمی‌شوند، این زمان‌بندی فعلاً یک راهنمای ریتمیک تقریبی است.

ماژول `engine/midi_renderer.py` بدون پکیج شخص ثالث فایل MIDI پنج‌ترکه می‌سازد. ماژول `engine/sample_renderer.py` نیز رویدادهای طرح آهنگ را به پخش نمونه‌های ضبط‌شده تبدیل می‌کند و WAV استریوی ۱۶بیتی می‌سازد. تغییر زیر و بمی در این نسخه با تغییر سرعت پخش نمونه انجام می‌شود، بنابراین مدت و رنگ صوتی نمونه نیز تغییر می‌کند؛ time-stretch حرفه‌ای هنوز وجود ندارد. برای هر بخش باید نمونهٔ مناسب در بانک محلی وجود داشته باشد.

شمارش هجا در فارسی ترکیبی از واژه‌نامهٔ تلفظِ دستی برای تعدادی واژهٔ پرتکرار ترانه و تخمین املایی برای واژه‌های ناشناخته است. واژه‌های واژه‌نامه با برچسب اطمینان بالا و بخش‌بندی هجایی ثبت می‌شوند و همین تعداد هجا در زمان‌بندی عبارت‌ها اثر می‌گذارد. برای واژه‌های خارج از واژه‌نامه، واکه‌های بلند و اعراب فقط شواهد نوشتاری‌اند؛ واکه‌های کوتاهِ نوشته‌نشده قابل بازیابی قطعی نیستند. تکیهٔ واژگانی عمداً `unknown` می‌ماند و وزن عروضی هنوز پیاده‌سازی نشده است. الگوهای بیس و درام فعلاً پایه و قطعی هستند و هنوز تنظیم حرفه‌ای وابسته به بخش، سبک و اجرای انسانی محسوب نمی‌شوند.

## مراحل ساخت فناوری خودمان

1. بهبود تحلیل فارسی: آوانویسی، هجا، تکیه، وزن، قافیه و معنا
2. آهنگسازی: ملودی، هارمونی، voice-leading و فرم متناسب با شعر
3. **انجام شد، نسخهٔ پایه:** خروجی MIDI پنج‌ترکه با ملودی، آکورد، بیس و درام
4. توسعهٔ groove و تنظیم پویا متناسب با سبک و بخش‌های آهنگ
5. ساخت بانک صدای اختصاصی سازها با نمونه‌برداری ضبط‌شده و مجاز
6. موتور رندر چندسازه‌ای و زمان‌بندی اجرای سازها
7. میکس، مسترینگ و خروجی WAV
8. پژوهش و آموزش مدل‌های اختصاصی برای وکال و تولید موسیقی، با داده و مجوز روشن

## مسیر یکپارچهٔ انتخاب روش آهنگسازی

مسیر احراز هویت‌شدهٔ `POST /v1/compose-by-mode` رابط واحد سه روش ساخت را فراهم می‌کند. مقدار `composition_mode` باید یکی از این سه مقدار باشد:

- `lyrics_first`: شعر الزامی است و هسته از شعر طرح آهنگ و MIDI می‌سازد.
- `instrumental_first`: شعر ارسال نمی‌شود؛ ابتدا طرح بی‌کلام و راهنمای جای‌گذاری شعر ساخته می‌شود.
- `co_creation`: شعر و طرح موسیقی با هم ساخته و خطوط شعر روی عبارت‌های ملودی هم‌تراز می‌شوند.

نمونهٔ بدنهٔ درخواست:

```json
{
  "composition_mode": "co_creation",
  "title": "همراه",
  "genre": "pop",
  "mood": "hopeful",
  "bpm": 104,
  "phrase_count": 8,
  "lyrics": "فردا دوباره می‌رسد\\nآفتاب از راه می‌رسد"
}
```

برای هر سه مسیر، پاسخ شامل `composition_mode`، طرح کامل، اطلاعات فایل MIDI و `audio_rendered: false` است. رابط عمومی استودیو اکنون درخواست سه مسیر ساخت را از طریق پراکسی احراز هویت‌شدهٔ Worker ارسال می‌کند. برای اجرای زنده، کنترل‌پلین Python باید روی میزبان خصوصی با بستهٔ Docker و Cloudflare Tunnel مستقر شود؛ توکن موتور هرگز نباید در JavaScript مرورگر قرار بگیرد. راهنمای استقرار در بخش «استقرار خصوصی با Docker و Cloudflare Tunnel» آمده است.

## اجرای تست‌ها

```bash
python3 -m unittest discover -s engine -p 'test_*.py' -v
```

نیازی به نصب پکیج شخص ثالث برای هستهٔ فعلی نیست.

## کنترل‌پلین محلی

سرویس `engine/server.py` فقط روی `127.0.0.1` گوش می‌دهد و پروژه‌ها را در SQLite نگه می‌دارد. مسیر `POST /v1/compose` طرح و MIDI می‌سازد. مسیر احراز هویت‌شدهٔ `POST /v1/compose-audio` با بانک نمونهٔ محلی WAV تولید می‌کند؛ اگر بانک معتبر و کامل در دسترس نباشد، با وضعیت `503` متوقف می‌شود و هیچ هزینه‌ای ثبت نمی‌کند. مسیر عمومی job runner یعنی `POST /v1/jobs` تا زمان تکمیل موتور تولید حرفه‌ای همچنان متوقف است.

برای استفاده از WAV، ابتدا پوشهٔ بانک صدا را با فایل `bank.json` و نمونه‌های ضبط‌شدهٔ 16-bit PCM WAV آماده کنید. سپس مسیر آن را در متغیر `MEHRAN_SAMPLE_BANK` قرار دهید. نام‌های پیش‌فرض سازها در بانک باید `piano`، `bass` و `drums` باشند. لایه‌های اختیاری `guitar`، `strings` و `electric_guitar` نیز از طریق تنظیم نگاشت سازها قابل فعال‌سازی‌اند و برای آن‌ها نمونهٔ واقعی جداگانه لازم است. نمونه‌های هر نت و لایهٔ velocity باید واقعاً در بانک وجود داشته باشند. این مسیر را برای فایل‌های ناشناس یا دانلودهای تأییدنشده تنظیم نکنید.\n\nبرای اجرا، Python 3.10 یا جدیدتر لازم است:

```bash
export MEHRAN_STUDIO_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
python3 engine/server.py
```

در Windows PowerShell:

```powershell
$env:MEHRAN_STUDIO_TOKEN = python -c "import secrets; print(secrets.token_urlsafe(48))"
python engine/server.py
```

**اصل معماری:** مالکیت مسیر آهنگسازی، کد، فرمت‌های میانی، بانک صدا و رندرر با MEHRAN است. ساخت مدل عصبی اختصاصی نیازمند دادهٔ آموزشی، آزمایش و توان پردازشی است؛ این نیاز را با ادعای آماده‌بودن مدل پنهان نمی‌کنیم.


## اعتبارسنجی بانک سمپل ضبط‌شده

کاتالوگ ضبط اکنون ۳۵ خانوادهٔ ساز را پوشش می‌دهد؛ این عدد نیازمندی ضبط را توصیف می‌کند، نه تعداد سازهایی که رندرر فعلی از قبل اجرا می‌کند. برای بررسی یک بانک WAV محلی، از ابزار فقط‌خواندنی زیر استفاده کنید:

```bash
python3 engine/sample_bank_tool.py /path/to/sample-bank
```

گزارش JSON شامل پوشش دقیق نت و لایهٔ velocity، فایل‌های ثبت‌شده، هشدارهای سیگنال و وضعیت هر خانوادهٔ ساز است. کد خروج:
- `0`: پوشش کامل کاتالوگ و عبور از بررسی‌های پایهٔ سیگنال
- `2`: بانک معتبر است، اما پوشش ناقص یا هشدار سیگنال دارد
- `1`: manifest یا فایل‌های بانک نامعتبر/ناقص‌اند

این ابزار فقط گزارش می‌سازد و فایل‌های WAV یا manifest را تغییر نمی‌دهد. عبور از آن تضمین شنیداری کیفیت ساز، کوک، اجرای نوازنده یا آمادگی میکس نیست.


## Articulation-aware sample playback

The sample manifest accepts an optional `articulation` slug per WAV entry. Older manifests remain compatible and default to `sustain`. The same instrument, MIDI note and velocity range may have multiple distinct articulation recordings, provided each articulation has its own manifest entry and file. Playback events may request an exact articulation, for example `sustain`, `staccato`, `pizzicato`, `palm_mute`, or `tremolo`. The renderer never silently substitutes another articulation: if the requested recording is absent, the event is rejected with a clear error. These names are metadata labels, not a claim that every instrument already has every articulation recorded.

Example manifest entry:

```json
{
  "instrument": "violin",
  "midi_note": 60,
  "velocity_min": 1,
  "velocity_max": 127,
  "articulation": "pizzicato",
  "path": "violin/c4_pizzicato.wav"
}
```

Example playback event field: `"articulation": "pizzicato"`.


## Articulation-aware recording plan and coverage

The recording checklist and CSV sheet now expand each instrument into distinct performance-technique targets as well as note and velocity targets. The 35-instrument catalog has instrument-specific technique labels, including Persian tar/setar mezrab directions and tremolo, violin-family bowing and pizzicato, guitar picking and palm muting, and percussion hit/roll variants. These are recording requirements, not claims that the techniques are already sampled or renderer-ready.

Every CSV row includes an `articulation` column, and suggested file paths are grouped by instrument and technique, for example `violin/pizzicato/60_main.wav`. The manifest's optional `articulation` field must match the requested technique exactly. Older entries default to `sustain`.

Coverage diagnostics now require exact instrument, note, velocity-zone and articulation matches. A bank containing every pitch but only sustained performances will correctly remain incomplete when staccato, pizzicato or other techniques are also required. Missing articulation names are reported per instrument. The checklist is version 2; the WAV manifest remains format version 1 and is backward compatible.

The authenticated exact-note preview endpoint also accepts an optional `articulation` query parameter, for example `/v1/sample-bank/preview?instrument=violin&note=60&velocity=80&articulation=pizzicato`. When omitted, it uses `sustain` for compatibility. It never previews a different articulation as a fallback.



## Deterministic articulation planning

`engine/articulation_planner.py` adds a deterministic planning layer that selects an instrument-supported performance technique from note duration, repeated pitches, phrase endings, melodic leaps and a requested expressive style. It uses the same instrument articulation catalog as the recording checklist.

Example:

```python
from articulation_planner import plan_articulations

result = plan_articulations(
    [
        {"midi_note": 60, "duration_ticks": 240},
        {"midi_note": 64, "duration_ticks": 960, "phrase_final": True},
    ],
    instrument="violin",
    tempo_bpm=92,
    style="expressive",
)
```

The planner returns per-event technique choices, reasons, confidence and counts. An explicitly requested technique is preserved; if it is not listed among the available recordings, the event is marked `blocked_missing_sample` rather than silently replaced. The default available set represents catalog capability only. Pass `available_articulations` from verified bank coverage when planning against a real bank. This layer currently produces planning metadata and is not yet wired into automatic composition rendering. It does not create audio or imply that recordings exist.


### Melody-linked articulation planning

The composition core now accepts optional `melody_instrument` and `articulation_style` arguments (defaults: `piano` and `balanced`). It runs the deterministic articulation planner on each generated melody phrase and attaches the selected technique and decision reason to each note's lyric-alignment metadata. The composition also reports a `melody_performance` summary with instrument, style, planner version and event count.

Example:

```python
plan = compose_plan(
    lyrics,
    melody_instrument="violin",
    articulation_style="legato",
)
```

The renderers now consume these labels with deliberately different guarantees:\n\n- The MIDI renderer writes one Standard MIDI marker meta-event per planned melody articulation. These markers preserve the technique label and note index for compatible downstream tools; they do not change the MIDI note sound by themselves. The report identifies this as metadata-only rendering.\n- The sample-event builder transfers the planner exact articulation into melody events. The recorded-sample renderer performs exact instrument, nearest-pitch, velocity-layer and articulation selection. It never substitutes sustain or another technique when the requested articulation is absent.\n- A missing exact recording blocks the WAV render with an explicit diagnostic. Successful WAV reports distinguish planner-selected articulations from legacy sustain defaults, renderer matching support, exact sample availability and whether audio was actually rendered.\n\nOlder hand-authored sample events without an articulation field remain compatible and default to `sustain`. The sample bank still needs real recorded WAV assets; this integration does not create or imply that recordings exist.


### Articulation-aware note shaping

Each planned melody note now carries a bounded performance profile in addition to its sample articulation: gate_ratio controls the sounding portion of the notated duration, and release_ms controls the final fade. Short articulations receive tighter gates and releases; sustained or bowed articulations retain more of the written duration and a longer release. The MIDI renderer applies the gate to note-off timing and preserves both values in marker metadata. The recorded-sample renderer applies the same gate and uses the selected release duration for its amplitude envelope. Older plans and hand-authored events retain the previous 0.88 gate and 25 ms release defaults. These controls shape playback only; they do not manufacture missing instrument recordings or replace exact articulation sample matching.


### Per-note musical dynamics

The composition core assigns deterministic note-level dynamics with `natural`, `crescendo`, `decrescendo`, `arch`, and `steady` phrase curves. Each melody note carries a MIDI velocity target (1–127), a conventional dynamic mark (`pp` through `ff`), the selected curve and a decision reason. Curated Persian lexical stress can add a controlled accent only when the pronunciation lexicon supplies a trusted stress position; unknown stress remains unaccented. Phrase-final notes receive a small release reduction.

Pass `dynamics_style="crescendo"` (or another supported curve) to `compose_plan`. The MIDI and recorded-sample renderers both consume the same per-note velocity target while retaining their existing beat and section shaping. The dynamics layer changes performance velocity, not the underlying recorded instrument timbre or availability of velocity-layer samples. This remains a deterministic rule-based planner, not a learned expressive-performance model.


### Arrangement part expression and stereo placement

The recorded-sample event builder now applies deterministic, section-aware stereo expression to each arrangement part. Melody, bass, kick and snare remain centered; closed hats alternate left/right; open hats and optional guitar layers receive stable positions. Chord and string width metadata follows the section arc, widening in choruses and narrowing in bridges. Existing chord-voice positions are retained and adjusted within safe pan bounds.

Each sample event carries its expression profile and planner version for diagnostics. The pan value is applied by the stereo sample renderer; `stereo_width` is descriptive arrangement metadata and is not a separate DSP widening effect. This layer does not synthesize stereo recordings, replace a real instrument bank, or claim a completed mastering chain. MIDI rendering remains unchanged in this step.


## پراکسی امن برای استودیو وب

Worker مسیر `POST /music/engine/compose` را برای اتصال آیندهٔ رابط وب فراهم می‌کند. این مسیر:

- فقط با نشست معتبر مدیر Pi با نام کاربری `mehranmsh` کار می‌کند.
- درخواست‌ها را به آدرس HTTPS از پیش تنظیم‌شده می‌فرستد؛ کاربر نمی‌تواند مقصد شبکه را تعیین کند.
- توکن موتور را فقط از secret سمت Worker می‌خواند و هرگز به مرورگر برنمی‌گرداند.
- محدودیت تعداد درخواست، اندازهٔ پاسخ و اعتبارسنجی حالت/پارامترها دارد.
- مسیر فایل محلی MIDI را از پاسخ عمومی حذف می‌کند.

برای فعال‌سازی، موتور Python باید روی میزبان خصوصیِ قابل دسترس با HTTPS مستقر شود. سپس آدرس کامل endpoint و توکن همسان را فقط در تنظیمات سمت سرور Worker قرار دهید:

```sh
npx wrangler secret put MEHRAN_ENGINE_TOKEN
```

`MEHRAN_ENGINE_COMPOSE_URL` یک متغیر سمت Worker است که باید به URL کامل `https://.../v1/compose-by-mode` اشاره کند. مقدار secret را هرگز در مخزن، `wrangler.jsonc` یا JavaScript عمومی قرار ندهید.

**وضعیت فعلی:** این پراکسی پیاده‌سازی شده، اما تا زمانی که موتور روی میزبان خصوصی مستقر و دو تنظیم سمت Worker پیکربندی نشوند، عمداً با پاسخ `503` بسته می‌ماند. سرویس Python فعلی همچنان فقط روی loopback اجرا می‌شود؛ بنابراین هنوز اتصال زنده یا رندر ابری فعال نیست.


## استقرار خصوصی با Docker و Cloudflare Tunnel

فایل‌های `engine/Dockerfile` و `docker-compose.engine.yml` یک بستهٔ استقرار آماده می‌کنند؛ این فایل‌ها به‌تنهایی چیزی را روی اینترنت منتشر نمی‌کنند. سرویس موتور در شبکهٔ داخلی Docker قرار می‌گیرد، هیچ `ports:` عمومی ندارد و تنها سرویس `cloudflared` به آن دسترسی شبکه‌ای می‌دهد.

### پیش‌نیازها

- یک میزبان لینوکسی تحت کنترل مالک با Docker Engine و Docker Compose
- یک Cloudflare Tunnel ساخته‌شده در حساب مالک
- یک hostname اختصاصی مانند `engine.example.com` که در تنظیمات Public Hostname تونل به سرویس `http://engine:8765` متصل شود
- نگهداری پایدار Volume برای دیتابیس و فایل‌های MIDI

### آماده‌سازی امن میزبان

از ریشهٔ مخزن:

```bash
cp .env.example .env
python3 -c 'import secrets; print(secrets.token_urlsafe(48))'
```

مقدار تصادفی را در `MEHRAN_STUDIO_TOKEN` فایل محلی `.env` قرار دهید و توکن Cloudflare Tunnel را در `CLOUDFLARE_TUNNEL_TOKEN` بگذارید. فایل واقعی `.env` در `.dockerignore` و `.gitignore` قرار دارد و نباید commit یا برای دیگران ارسال شود. سرویس `cloudflared` این مقدار را از متغیر محیطی `TUNNEL_TOKEN` می‌خواند؛ توکن در آرگومان خط فرمان پردازش قرار نمی‌گیرد. دسترسی به Docker daemon و فایل `.env` همچنان باید فقط برای مدیر میزبان محدود باشد.

سپس:

```bash
docker compose --env-file .env -f docker-compose.engine.yml config
docker compose --env-file .env -f docker-compose.engine.yml build
docker compose --env-file .env -f docker-compose.engine.yml up -d
docker compose --env-file .env -f docker-compose.engine.yml ps
```

در داشبورد Cloudflare برای تونل، Public Hostname را به سرویس داخلی `http://engine:8765` route کنید. پورت 8765 را در فایروال میزبان باز نکنید و آن را با `ports:` به اینترنت publish نکنید. مجوز bind روی `0.0.0.0` فقط با `MEHRAN_STUDIO_ALLOW_CONTAINER_BIND=1` و در فایل Compose ایزوله فعال شده است؛ اجرای عادی Python همچنان فقط loopback را می‌پذیرد.

### اتصال Worker

در تنظیمات Worker مقدار متغیر عادی `MEHRAN_ENGINE_COMPOSE_URL` را روی URL کامل و HTTPS قرار دهید، برای مثال:

`https://engine.example.com/v1/compose-by-mode`

سپس secret سمت Worker را جداگانه تنظیم کنید:

```bash
npx wrangler secret put MEHRAN_ENGINE_TOKEN
```

مقدار این secret باید دقیقاً با `MEHRAN_STUDIO_TOKEN` میزبان موتور یکسان باشد. هیچ‌یک از این دو مقدار نباید در GitHub، JavaScript عمومی، خروجی مرورگر یا پیام‌های پشتیبانی قرار گیرد. پراکسی Worker نشست مالک Pi را بررسی می‌کند و توکن موتور را فقط server-to-server ارسال می‌کند.

### عملیات و نگهداری

```bash
docker compose --env-file .env -f docker-compose.engine.yml logs --tail=100 engine tunnel
docker compose --env-file .env -f docker-compose.engine.yml restart
docker compose --env-file .env -f docker-compose.engine.yml down
```

دستور `down` داده‌های Volume را حذف نمی‌کند. از Volume `mehran-engine-data` به‌طور منظم نسخهٔ پشتیبان رمزگذاری‌شده تهیه کنید. حذف Volume یا اجرای `down -v` داده‌های پروژه و فایل‌های MIDI را پاک می‌کند.

**وضعیت فعلی:** بستهٔ Docker و تنظیمات تونل به مخزن اضافه شده‌اند، اما هیچ میزبان، تونل، hostname یا secret واقعی از اینجا پیکربندی نشده است. تا زمانی که مالک این پیش‌نیازها را روی میزبان خودش تنظیم نکند و endpoint واقعی بررسی نشود، Worker عمداً با پاسخ `503` بسته می‌ماند و ساخت زندهٔ ابری فعال محسوب نمی‌شود.
