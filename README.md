# Network Monitor

سیستم مانیتورینگ شبکه با Electron Agent و Next.js Dashboard.

## اجرا

1. npm install
2. npm run dev
3. داشبورد: http://localhost:3000
4. روی کلاینت: npm run client

Agent هر ۳۰ ثانیه اطلاعات heartbeat شامل IP، MAC، نام کامپیوتر، کاربر، مشخصات پرسنلی، سیستم‌عامل، CPU و RAM را ارسال می‌کند.

وضعیت‌ها:
- آنلاین: حداکثر ۹۰ ثانیه از heartbeat
- اخیراً دیده‌شده: ۹۰ تا ۳۰۰ ثانیه
- آفلاین: بیشتر از ۳۰۰ ثانیه

مرحله بعدی پیشنهادی برای محیط سازمانی: احراز هویت Agent، HTTPS، جزئیات کامل کلاینت، history، discovery شبکه، مدیریت کاربران و نصب/اجرای خودکار Agent.
