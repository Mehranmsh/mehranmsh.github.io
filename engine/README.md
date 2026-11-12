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
