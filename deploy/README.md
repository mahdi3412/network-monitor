# استقرار Agent روی کلاینت‌ها

Agent روی هر کامپیوتر به‌صورت پس‌زمینه و بدون پنجره اجرا می‌شود: برنامه در `Program Files\NetworkMonitorAgent` نصب می‌شود و یک Scheduled Task آن را هنگام لاگین هر کاربر با `--hidden` اجرا می‌کند. اجرا داخل session خود کاربر است، پس نام کاربری ویندوز درست خوانده می‌شود.

شناسه کامپیوتر، کلید و تنظیمات در `C:\ProgramData\NetworkMonitor` (مشترک برای همه کاربران) ذخیره می‌شود؛ بنابراین حتی با چند کاربر روی یک سیستم فقط **یک رکورد** ساخته می‌شود.

## ۱. ساخت Agent (روی یک سیستم ویندوز، یک‌بار)

نیاز: Node.js 18 یا بالاتر و دسترسی اینترنت (برای دانلود Electron و electron-builder).

```
cd network-monitor
npm run build:agent
```

خروجی: `client\dist\win-unpacked\` (شامل `NetworkMonitorAgent.exe`). نسخه فایل از `client\package.json` گرفته می‌شود؛ برای انتشار نسخه جدید، `version` را بالا ببرید.

## ۲. گذاشتن روی یک Share

محتوای `win-unpacked` را روی یک share که **Domain Computers** اجازه خواندن آن را دارد کپی کنید، مثلاً:

```
\\fileserver\apps\NetworkMonitorAgent\
```

اسکریپت‌های `deploy\install-agent.ps1` را هم روی یک share خواندنی بگذارید (مثلاً `\\fileserver\apps\`).

## ۳. توزیع با GPO

1. در Group Policy Management یک GPO بسازید و به OU کامپیوترها لینک کنید.
2. `Computer Configuration ← Policies ← Windows Settings ← Scripts ← Startup ← PowerShell Scripts` را باز کنید و `install-agent.ps1` را اضافه کنید.
3. در Script Parameters بنویسید:

```
-ServerUrl http://monitor.example.local:3000 -SourcePath \\fileserver\apps\NetworkMonitorAgent
```

با هر بوت، اسکریپت نسخه نصب‌شده را با نسخه روی share مقایسه می‌کند و فقط در صورت تفاوت به‌روزرسانی می‌کند. برای انتشار نسخه جدید کافی است محتوای share را عوض کنید.

برای SCCM/Intune همان اسکریپت را با همین پارامترها (با دسترسی SYSTEM) اجرا کنید.

## ۴. پیش‌نیازها

- **فایروال:** کلاینت‌ها باید بتوانند به پورت سرور داشبورد (مثلاً TCP 3000) برسند.
- **سرور:** متغیرهای AD را تنظیم کنید (فایل README اصلی) تا نام و شماره پرسنلی پر شود.
- **آنتی‌ویروس:** Agent امضای دیجیتال ندارد؛ در صورت هشدار SmartScreen یا آنتی‌ویروس، مسیر `Program Files\NetworkMonitorAgent` را استثنا کنید یا فایل را با گواهی کد امضا کنید.

## ۵. استقرار مرحله‌ای (پیشنهادی)

1. ابتدا یک OU آزمایشی با ۲۰ تا ۵۰ سیستم.
2. بعد از ۲۴ ساعت بررسی کنید: تعداد رکوردها = تعداد سیستم‌ها (تکراری نباشد)، نام و پرسنلی پر شده، وضعیت آنلاین درست است.
3. بعد ۲۰۰ سیستم، و در نهایت همه.

## ۶. عیب‌یابی

| مشکل | بررسی |
|---|---|
| ایجنت ظاهر نمی‌شود | فایل `C:\ProgramData\NetworkMonitor\install.log` را ببینید؛ بعد از نصب، ایجنت از **لاگین بعدی** کاربر اجرا می‌شود |
| دو رکورد برای یک سیستم | احتمالاً از یک image کلون‌شده نصب شده؛ `agent-id` را در image پاک کنید و دوباره نصب کنید |
| نام و پرسنلی خالی است | همگام‌سازی کاربران AD هنوز اجرا نشده، یا کاربر با حساب محلی لاگین کرده، یا `employeeID` ندارد |
| آدرس سرور عوض نمی‌شود | `config.json` سراسری بر تنظیمات کاربر غالب است؛ اسکریپت را با `-ServerUrl` جدید دوباره اجرا کنید |

## ۷. حذف

```
powershell -ExecutionPolicy Bypass -File uninstall-agent.ps1
powershell -ExecutionPolicy Bypass -File uninstall-agent.ps1 -RemoveData   # شناسه و تنظیمات هم حذف شود
```

## نکته درباره کلون image

اگر کامپیوترها را از یک image می‌سازید، قبل از گرفتن image فایل `C:\ProgramData\NetworkMonitor\agent-id` را حذف کنید، وگرنه همه سیستم‌ها شناسه یکسان می‌گیرند و رکوردهایشان روی هم نوشته می‌شود.
