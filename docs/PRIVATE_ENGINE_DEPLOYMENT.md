# استقرار خصوصی موتور MEHRAN MUSIC

این راهنما برای اجرای کنترل‌پلین Python روی یک میزبان تحت کنترل مالک و اتصال آن از طریق Cloudflare Tunnel به Worker است. این استقرار، سرویس عمومی تولید صدا یا مدل عصبی نیست؛ endpoint فعلی سه مسیر آهنگسازی را به طرح و فایل MIDI تبدیل می‌کند.

## معماری اتصال

```text
Music Studio (browser)
        |
        | owner session
        v
Cloudflare Worker
  - verifies owner session
  - rate limits requests
  - keeps MEHRAN_ENGINE_TOKEN server-side
        |
        | HTTPS through Cloudflare Tunnel
        v
cloudflared container
        |
        | private Compose network
        v
engine container :8765
  POST /v1/compose-by-mode
  GET  /health
```

موتور هیچ پورتی را روی اینترنت میزبان publish نمی‌کند. سرویس `engine` فقط در شبکه داخلی Docker قابل دسترسی است؛ `cloudflared` تونل خروجی را برقرار می‌کند. endpoint عمومی تونل با Bearer token موتور محافظت می‌شود و Worker نیز فقط پس از تأیید نشست مالک درخواست را می‌فرستد.

## پیش‌نیازهای میزبان

- یک Linux host یا VPS تحت کنترل مالک، با Docker Engine و Docker Compose v2
- دسترسی خروجی HTTPS برای دریافت imageها و برقراری Cloudflare Tunnel
- فضای ذخیره‌سازی پایدار برای volume موتور و حداقل ۲ GiB فضای آزاد بالاتر از آستانه محافظت‌شده
- یک hostname تحت DNS مدیریت‌شده در Cloudflare
- دسترسی به Cloudflare Zero Trust برای ساخت Tunnel و تنظیم Public Hostname
- دسترسی به تنظیمات Worker برای افزودن متغیر و secret

این مخزن میزبان خصوصی را ایجاد نمی‌کند و هیچ سرویس ابری را به‌جای مالک ثبت یا خریداری نمی‌کند.

## ۱. آماده‌سازی فایل secrets روی میزبان

از ریشه repository اجرا کنید:

```bash
cp .env.example .env
chmod 600 .env
python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(48))
PY
```

خروجی آخر را به‌عنوان مقدار `MEHRAN_STUDIO_TOKEN` در فایل محلی `.env` قرار دهید. سپس مقدار توکن Cloudflare Tunnel را در `CLOUDFLARE_TUNNEL_TOKEN` بگذارید.

نمونهٔ شکل فایل، با placeholder و نه secret واقعی:

```dotenv
MEHRAN_STUDIO_TOKEN=REPLACE_WITH_RANDOM_48_BYTE_TOKEN
CLOUDFLARE_TUNNEL_TOKEN=REPLACE_WITH_CLOUDFLARE_TUNNEL_TOKEN
MEHRAN_STUDIO_MAX_PROJECTS=500
MEHRAN_STUDIO_MIN_FREE_BYTES=2147483648
```

- هر دو توکن باید محرمانه بمانند؛ فایل `.env` را commit، upload یا در پیام عمومی ارسال نکنید.
- Compose توکن Tunnel را از متغیر محیطی `TUNNEL_TOKEN` به `cloudflared` می‌دهد، نه از آرگومان خط فرمان؛ بااین‌حال دسترسی به Docker daemon و فایل `.env` باید فقط در اختیار مدیر میزبان باشد.
- مقدار `MEHRAN_STUDIO_TOKEN` باید دقیقاً همان مقداری باشد که بعداً در Worker Secret با نام `MEHRAN_ENGINE_TOKEN` ثبت می‌کنید.
- مقدار `MEHRAN_STUDIO_MIN_FREE_BYTES` در production را روی ۲ GiB یا بیشتر نگه دارید. مقدار صفر فقط برای smoke test موقت CI استفاده شده است، نه میزبان واقعی.
- پوشهٔ دادهٔ Docker volume پایدار است. حذف volume با `docker compose down -v` داده‌های SQLite را پاک می‌کند؛ از این دستور برای توقف عادی استفاده نکنید.

## ۲. ساخت Cloudflare Tunnel

در Cloudflare Zero Trust:

1. یک Tunnel جدید از نوع Docker بسازید.
2. توکن Tunnel را در `.env` میزبان قرار دهید.
3. در بخش Public Hostnames یک hostname اختصاصی اضافه کنید؛ برای مثال `engine.example.com`.
4. Service را روی `http://engine:8765` تنظیم کنید. نام `engine` از نام سرویس در `docker-compose.engine.yml` می‌آید و داخل شبکه Compose resolve می‌شود.
5. برای hostname عمومی، HTTPS را فعال نگه دارید. TLS سمت Cloudflare تا لبه برقرار است و Cloudflare Tunnel ترافیک را به سرویس داخلی می‌فرستد.

hostname نمونه است و باید با دامنه‌ای که مالک کنترل می‌کند جایگزین شود. هیچ رکورد DNS یا دامنه‌ای از این راهنما به‌صورت خودکار ساخته نمی‌شود.

## ۳. راه‌اندازی موتور و Tunnel

از ریشه repository روی میزبان اجرا کنید:

```bash
docker compose -f docker-compose.engine.yml up -d --build
docker compose -f docker-compose.engine.yml ps
docker compose -f docker-compose.engine.yml logs --tail=100 engine tunnel
```

سرویس موتور باید `healthy` شود و کانتینر Tunnel باید در حال اجرا باشد. در صورت خطا، ابتدا log هر دو سرویس را بررسی کنید. پورت 8765 را در firewall عمومی باز نکنید و از `ports:` برای انتشار آن روی host استفاده نکنید.

برای توقف بدون حذف داده‌ها:

```bash
docker compose -f docker-compose.engine.yml down
```

برای راه‌اندازی دوباره:

```bash
docker compose -f docker-compose.engine.yml up -d
```

## ۴. تنظیم Worker

در Cloudflare Dashboard برای Worker مربوط به `mehran-msh-auth`، بخش Settings → Variables and Secrets را باز کنید و این مقادیر را ثبت کنید:

| نام | نوع | مقدار |
|---|---|---|
| `MEHRAN_ENGINE_COMPOSE_URL` | Variable | `https://engine.example.com/v1/compose-by-mode` |
| `MEHRAN_ENGINE_TOKEN` | Secret | دقیقاً همان `MEHRAN_STUDIO_TOKEN` میزبان |

hostname و URL باید واقعی و متعلق به مالک باشند. توکن را فقط در Secret قرار دهید، نه Variable معمولی، GitHub، فایل HTML یا JavaScript مرورگر.

Worker endpoint را از نظر HTTPS و شکل URL اعتبارسنجی می‌کند، نشست مالک را بررسی می‌کند، درخواست‌ها را محدود می‌کند و مسیر فایل محلی MIDI را از پاسخ عمومی حذف می‌کند.

## ۵. استقرار Worker

Workflow موجود در `.github/workflows/deploy-worker.yml` برای branch `main` تنظیم شده و به GitHub Actions secrets زیر نیاز دارد:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

تا زمانی که تغییرات شاخهٔ توسعه وارد `main` نشده‌اند، workflow انتشار خودکار از این شاخه اجرا نمی‌شود. ادغام PR باید با تصمیم صریح مالک انجام شود. همچنین می‌توان Worker را از محیط مورد اعتماد مالک با Wrangler و پیکربندی `wrangler.jsonc` منتشر کرد؛ توکن موتور را به فایل پیکربندی اضافه نکنید.

## ۶. بررسی اتصال قبل از استفاده

ابتدا health check را از طریق hostname تونل با توکن موتور بررسی کنید:

```bash
curl --fail --silent --show-error \
  -H "Authorization: Bearer $MEHRAN_STUDIO_TOKEN" \
  https://engine.example.com/health
```

درخواست بدون توکن باید `401` برگرداند:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  https://engine.example.com/health
```

سپس از Music Studio با نشست تأییدشدهٔ مالک، هر سه حالت را آزمایش کنید:

- `lyrics_first`
- `instrumental_first`
- `co_creation`

پاسخ موفق باید `composition_created: true`، حالت منطبق و فایل Standard MIDI معتبر داشته باشد. در نسخهٔ فعلی، `audio_rendered: false` نتیجهٔ مورد انتظار است؛ این endpoint به‌تنهایی WAV، وکال یا مستر نهایی تولید نمی‌کند.

## ۷. نگهداری و بازیابی

- از volume پایدار `mehran-engine-data` و فایل `.env` به‌صورت جداگانه backup رمزگذاری‌شده تهیه کنید.
- پیش از به‌روزرسانی image، وضعیت volume و فضای دیسک را بررسی کنید.
- برای مشاهده وضعیت: `docker compose -f docker-compose.engine.yml ps`
- برای log: `docker compose -f docker-compose.engine.yml logs --since=30m engine tunnel`
- در صورت افشای هر توکن، آن را فوراً rotate کنید: مقدار جدید در میزبان و Worker باید هماهنگ باشد.
- فایل `.env`، SQLite database، backupها و توکن Tunnel را به repository اضافه نکنید.
- هیچ‌گاه `docker compose down -v` را به‌عنوان دستور پاک‌سازی عادی اجرا نکنید.

## وضعیت

CI ساخت image، health endpoint، احراز هویت و اجرای سه حالت آهنگسازی در کانتینر را بررسی می‌کند. این آزمایش‌ها جایگزین استقرار روی میزبان واقعی، تنظیم hostname واقعی، ثبت secretها و تست end-to-end در Music Studio نیستند. استقرار production فقط پس از انجام مراحل بالا قابل تأیید است.
