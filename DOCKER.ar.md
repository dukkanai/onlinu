# تشغيل AstraCalls باستخدام Docker

يُشغَّل التطبيق وقاعدة PostgreSQL في حاويتين، وتُحفظ قواعد بيانات جلسات واتساب والتسجيلات في وحدات تخزين مستقلة عن الصورة. إعادة إنشاء الحاويات أو تغيير إصدار الصورة يحافظ على هذه البيانات ما دامت وحدات التخزين محفوظة. الصورة لا تحتوي على ملف `.env` أو بيانات حسابات واتساب.

تحتاج إلى Docker Engine مع إضافة Docker Compose الحديثة، وإلى `openssl` لإنشاء الإعدادات. اسم الصورة المستخدم في أوامر هذا الإصدار هو `astracalls-translation:0.3.0` لمعمارية `linux/amd64`؛ وجود الدليل لا يغني عن بناء الصورة والتحقق منها قبل نشرها. لم يُتحقق من تشغيل إصدار ARM64؛ يلزمه بناء واختبار منفصلان.

الإصدار `0.3.0` يقدّم المنيو العام على `/` وإدارة المطعم على `/admin`، وتنتقل لوحة واتساب القائمة إلى `/admin/calls`. يبدأ المطعم الجديد بمنيو تجريبي معلّم وطاولات مستقلة دون طلبات عملاء؛ راجع [دليل المطعم](RESTAURANT.ar.md) لضبط المنيو والتوصيل والطاولات والحسابات واللغات. لا يحتاج عمل الطلبات إلى مفتاح OpenAI أو ربط واتساب.

## التشغيل الأول

نفّذ الأوامر من مجلد المشروع:

```bash
./scripts/init-env.sh
docker compose -p astracalls-main --env-file .env -f compose.translation.yml build astracalls
docker compose -p astracalls-main --env-file .env -f compose.translation.yml up -d --wait
docker compose -p astracalls-main --env-file .env -f compose.translation.yml ps
```

ينشئ الأمر الأول ملف `.env` بصلاحيات `600` ومفتاح تطبيق وكلمة مرور قاعدة بيانات ومفتاح تشفير Meta عشوائية مستقلة، ولا يغيّر ملفًا موجودًا. أضف `OPENAI_API_KEY` داخل هذا الملف محليًا لتفعيل الترجمة. لا ترسل محتوى الملف في المحادثات ولا تحفظه في Git. لا تغيّر `POSTGRES_PASSWORD` بعد إنشاء قاعدة البيانات دون تغيير كلمة المرور داخل PostgreSQL أيضًا.

افتح `http://127.0.0.1:8080` على الجهاز المضيف لتصفح المطعم، و`http://127.0.0.1:8080/admin` لإدارته. إعدادات البداية تربط HTTP ومنفذ الوسائط على `127.0.0.1` فقط. من `/admin/calls` اختر الربط عبر QR أو حساب WhatsApp Business Platform الرسمي. يحتاج الخيار الرسمي إلى حساب Meta مؤهل وإعداد HTTPS وWebhook وبيانات اعتماد خاصة بالعميل؛ راجع [دليل Meta](META.ar.md). تحتاج المكالمات والترجمة إلى اختبار فعلي في الاتجاهين بعد الربط وإضافة مفتاح OpenAI؛ نجاح Docker أو الاختبارات المحلية وحده لا يثبت نجاح الاتصال بالخدمة الخارجية.

لمتابعة الحالة والسجلات:

```bash
docker compose -p astracalls-main --env-file .env -f compose.translation.yml ps
docker compose -p astracalls-main --env-file .env -f compose.translation.yml logs --tail=100 -f astracalls
curl --fail http://127.0.0.1:8080/healthz
```

فحص `/healthz` يتحقق أيضًا من اتصال قاعدة البيانات. يعمل التطبيق كمستخدم غير جذري `UID 10001` بنظام ملفات للقراءة فقط، مع مساحة مؤقتة قابلة للكتابة وحفظ التسجيلات في `/data/recordings`. تبقى سياسة حذف التسجيلات الأقدم من 48 ساعة الموجودة في التطبيق سارية.

لاختبار الصورة محليًا قبل نشر إصدار جديد:

```bash
ASTRACALLS_IMAGE=astracalls-translation:0.3.0 bash scripts/docker-smoke.sh
```

يحتاج الاختبار إلى `curl` و`jq` و`openssl` و`python3` وصورتي التطبيق وPostgreSQL محمّلتين محليًا. ينشئ مشروعين مؤقتين بمنافذ ومفاتيح عشوائية دون استخدام ملف إعداداتك، ويختبر عزل البيانات والمصادقة، وفشل فحص الصحة عند توقف قاعدة البيانات ثم تعافيه، وترميز MP3 كمستخدم محدود، وبقاء البيانات والتسجيلات بعد استبدال الحاويات. يحذف فقط مشروعي الاختبار ووحدات التخزين الخاصة بهما عند الانتهاء.

## التشغيل على خادم بعيد

اضبط `.env` قبل تشغيل المكالمات من جهاز آخر:

```dotenv
WACALLS_PUBLIC_IP=203.0.113.10
WACALLS_MEDIA_BIND=0.0.0.0
WACALLS_UDP_PORT=50000
WACALLS_PUBLIC_BASE_URL=https://calls.example.com
```

العنوان والنطاق أعلاه أمثلة؛ استبدلهما بعنوان الخادم العام القابل للوصول ونطاقك الحقيقي. افتح أو وجّه المنفذ المختار للوسائط لكل من UDP وTCP في جدار الحماية وNAT. ضع HTTPS reverse proxy أمام منفذ التطبيق، لأن استخدام ميكروفون المتصفح عن بُعد يحتاج إلى HTTPS. يمكن إبقاء `WACALLS_HTTP_BIND=127.0.0.1` إذا كان الوكيل يعمل على المضيف نفسه، أو ضبطه وفق شبكة الوكيل؛ لا يكفي تغيير عنوان IP وحده لإعداد HTTPS أو الجدار الناري.

بعد تعديل إعدادات البيئة، أعد تطبيقها:

```bash
docker compose -p astracalls-main --env-file .env -f compose.translation.yml up -d --wait
```

## نقل الصورة إلى خادم آخر

احفظ صورة التطبيق وصورة PostgreSQL معًا عند النقل دون إعادة البناء. استخدم اسم ملف جديدًا إذا كانت هناك نسخة سابقة تريد الاحتفاظ بها:

```bash
mkdir -p /home/chatbot/wa/artifacts
docker image save astracalls-translation:0.3.0 postgres:16-bookworm | gzip > /home/chatbot/wa/artifacts/astracalls-translation-0.3.0-linux-amd64.tar.gz
sha256sum /home/chatbot/wa/artifacts/astracalls-translation-0.3.0-linux-amd64.tar.gz
```

انقل الأرشيف وملفات `compose.translation.yml` و`.env.example` و`scripts/init-env.sh` مع الحفاظ على ترتيب المجلدات. قارن بصمة SHA-256 على الجهازين للتحقق من النقل. على الخادم الجديد، من مجلد الملفات:

```bash
docker image load --input astracalls-translation-0.3.0-linux-amd64.tar.gz
./scripts/init-env.sh
docker compose -p astracalls-main --env-file .env -f compose.translation.yml up -d --no-build --pull never --wait
```

عدّل `.env` لإعداد OpenAI وعنوان الخادم قبل تشغيل المكالمات. نقل الصور وحدها ينشئ تثبيتًا ببيانات جديدة؛ نقل الحسابات والتسجيلات القائمة يحتاج إلى نسختها الاحتياطية وملف الإعدادات المناسب عبر قناة آمنة، بما فيه مفتاح `WACALLS_META_ENCRYPTION_KEY` الأصلي عند نقل حسابات Meta المشفرة. أوقف النسخة القديمة قبل تشغيل النسخة المنقولة بنفس جلسات واتساب. ويمكن نشر الصورة في سجل صور خاص واستخدام `ASTRACALLS_IMAGE` للإشارة إلى اسمها هناك.

## تشغيل عدة نسخ مستقلة

استخدم اسم مشروع Compose مختلفًا وملف إعدادات خاصًا لكل نسخة. يمنح هذا كل نسخة شبكتها وقاعدة بياناتها ووحدات تخزينها الخاصة. مثال لنسخة ثانية:

```bash
./scripts/init-env.sh .env.second
```

عدّل `.env.second`، مع إبقاء بيانات الاعتماد الجديدة الخاصة بها وضبط منافذ مختلفة:

```dotenv
WACALLS_HTTP_PORT=8081
WACALLS_UDP_PORT=50001
```

اضبط أيضًا مفتاح OpenAI وعنوان الخادم وإعدادات النشر المناسبة لتلك النسخة، ثم شغّلها:

```bash
docker compose -p astracalls-second --env-file .env.second -f compose.translation.yml up -d --no-build --wait
```

اربط جلسات واتساب الخاصة بكل نسخة بصورة مستقلة، واضبط حساب Meta ومسار Webhook الصحيح عند استخدام الربط الرسمي. لكل نسخة مفتاح تشفير مستقل؛ لا تنسخ بيانات اعتماد عميل إلى نسخة عميل آخر. لا تستخدم `--scale astracalls`، ولا تشغّل حاويتين على قاعدة بيانات جلسة واتساب نفسها في الوقت نفسه. إعادة استخدام الصورة آمنة؛ مشاركة بيانات الجلسة الحية بهذه الطريقة غير مدعومة. احتفظ دائمًا باسم المشروع وملف الإعدادات الصحيحين عند إدارة أي نسخة.

## إضافة مفتاح تشفير Meta لتثبيت قائم

الربط عبر QR لا يتطلب هذا المفتاح. أما حفظ بيانات اعتماد الربط الرسمي فيتطلب `WACALLS_META_ENCRYPTION_KEY` ثابتًا: قيمة Base64 لـ32 بايت عشوائية. التثبيت الجديد يولّد المفتاح تلقائيًا؛ تشغيل `init-env.sh` فوق ملف موجود لا يضيفه ولا يستبدله عمدًا.

قبل تفعيل أول حساب Meta في نسخة قديمة، خذ نسخة احتياطية من `.env`، ثم ولّد قيمة محليًا بأداة مثل `openssl rand -base64 32` وضعها مرة واحدة في سطر `WACALLS_META_ENCRYPTION_KEY=` باستخدام محرّر آمن. لا تشارك القيمة، ولا تضف سطرًا مكررًا، ولا تنفّذ هذه الخطوة إذا كان مفتاح صالح موجودًا بالفعل. أعد إنشاء حاوية التطبيق لتطبيق البيئة، في وقت لا توجد فيه مكالمة نشطة:

```bash
docker compose -p astracalls-main --env-file .env -f compose.translation.yml up -d --no-deps --no-build --wait astracalls
```

احفظ المفتاح مع النسخة الاحتياطية لقاعدة البيانات. فقدانه أو استبداله يمنع فك بيانات اعتماد Meta المخزنة؛ إنشاء مفتاح آخر لا يستعيدها. لا يؤثر غياب المفتاح على ربط QR، لكنه يمنع تشغيل الحسابات الرسمية المشفرة. لا توجد آلية تدوير تلقائي لهذا المفتاح في هذا الإصدار.

## النسخ الاحتياطي قبل التحديث

تحتوي وحدة `translation-postgres` على قاعدة التحكم وقواعد جلسات واتساب وبيانات المطعم والطلبات والعملاء، ولذلك يلزم نسخ جميع قواعد البيانات باستخدام `pg_dumpall`. تحتوي `translation-recordings` على التسجيلات وصور المطعم في مجلد `restaurant-images`. أسماء وحدات التخزين الفعلية مسبوقة باسم مشروع Compose، مثل `astracalls-main_translation-postgres`.

نفّذ النسخ في وقت لا توجد فيه مكالمة نشطة؛ إيقاف التطبيق يقطع أي مكالمة جارية. الأوامر التالية تترك PostgreSQL قيد التشغيل لقراءة البيانات وتوقف التطبيق مؤقتًا لضمان اتساق النسخة:

```bash
umask 077
backup_path="$PWD/backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup_path"
docker compose -p astracalls-main --env-file .env -f compose.translation.yml stop astracalls
docker compose -p astracalls-main --env-file .env -f compose.translation.yml exec -T postgres pg_dumpall -U astracalls > "$backup_path/postgres-all.sql"
docker compose -p astracalls-main --env-file .env -f compose.translation.yml cp astracalls:/data/recordings "$backup_path/recordings"
cp .env "$backup_path/config.env"
chmod 600 "$backup_path/config.env" "$backup_path/postgres-all.sql"
```

تحقق من نجاح كل أمر قبل الانتقال إلى التحديث. إذا فشل النسخ، عالج السبب قبل الاعتماد على الملفات الناتجة. للعودة إلى التشغيل بعد النسخ دون تحديث:

```bash
docker compose -p astracalls-main --env-file .env -f compose.translation.yml start astracalls
```

احفظ النسخة الاحتياطية مشفرة خارج الخادم؛ تحتوي قواعد البيانات على معلومات جلسات واتساب وبيانات اعتماد Meta المشفرة، ويحتوي `config.env` على أسرار التشغيل ومفتاح فك تشفيرها. قاعدة البيانات وحدها لا تكفي لاستعادة حسابات Meta دون مفتاحها الأصلي. اختبر الاستعادة في بيئة منفصلة قبل الاعتماد على النسخ في الإنتاج. استعادة `pg_dumpall` تحتاج إلى قاعدة PostgreSQL جديدة أو خطة استعادة مدروسة، ولا ينبغي تطبيقها عشوائيًا فوق بيانات حية. أعد التسجيلات مع الحفاظ على قابلية الكتابة للمستخدم `UID 10001`.

## تحديث التطبيق والرجوع إلى إصدار سابق

احتفظ بالصورة القديمة ونسخة احتياطية متوافقة معها. بعد تعديل الكود، غيّر في `.env` مثلًا:

```dotenv
ASTRACALLS_IMAGE=astracalls-translation:0.3.1
ASTRACALLS_VERSION=0.3.1
```

ابنِ الصورة الجديدة أولًا، ثم خذ النسخة الاحتياطية أعلاه قبل استبدال التطبيق:

```bash
docker compose -p astracalls-main --env-file .env -f compose.translation.yml build astracalls
```

بعد اكتمال النسخ الاحتياطي:

```bash
docker compose -p astracalls-main --env-file .env -f compose.translation.yml up -d --no-deps --no-build --wait astracalls
docker compose -p astracalls-main --env-file .env -f compose.translation.yml ps
docker compose -p astracalls-main --env-file .env -f compose.translation.yml logs --tail=100 astracalls
```

إذا كانت الصورة منشورة في سجل، استخدم `pull astracalls` بدل `build astracalls`. التحديث يوقف التطبيق مؤقتًا، وتبقى البيانات في وحدات التخزين. التعديلات داخل الحاوية ليست طريقة تحديث دائمة؛ عدّل المصدر وابنِ إصدارًا جديدًا.

للرجوع، أعد `ASTRACALLS_IMAGE` و`ASTRACALLS_VERSION` إلى الإصدار السابق وشغّل أمر `up` نفسه، بشرط توافق بنية قاعدة البيانات. إذا غيّر الإصدار الجديد بنيتها بصورة لا يدعمها القديم، يجب استعادة النسخة الاحتياطية الموافقة للإصدار السابق أيضًا. ترقية إصدار PostgreSQL الرئيسي عملية منفصلة تحتاج إلى خطة نقل بيانات، ولا تتم بمجرد تغيير `POSTGRES_IMAGE`.

لإيقاف النظام مؤقتًا استخدم `stop`. ويمكن استخدام `down` دون خيارات حذف وحدات التخزين ثم `up` مجددًا. تجنّب حذف وحدات التخزين أو تنظيفها بأوامر شاملة، لأنها تحمل بيانات الحسابات والتسجيلات.
