# mail-sorter

**Русский** | [English](README.md)

Программа для автоматического чтения ответов почтовых серверов ([Delivery Status Notification](https://ru.wikipedia.org/wiki/%D0%92%D0%BE%D0%B7%D0%B2%D1%80%D0%B0%D1%89%D1%91%D0%BD%D0%BD%D0%BE%D0%B5_%D0%BF%D0%B8%D1%81%D1%8C%D0%BC%D0%BE))
и реагирования на них.

## Что это такое и зачем это нужно

При выполнении рассылок по большой базе email-адресов можно столкнуться с тем, что
часть адресов "битая" - например, ящик не существует.
Если часто пытаться отправлять письма на "битые" адреса, то некоторые почтовые
сервисы (mail.ru, например) могут начать классифицировать рассылки как спам.

Решить эту проблему можно автоматической обработкой ответов почтовых серверов
(Delivery Status Notification, далее - DSN). Ящики, на которые не получилось
доставить письмо, исключаются из базы рассылок. Сортировщик предназначен для полностью
автоматического чтения почтового ящика вроде `noreply@some.domain`, куда обычно приходят
DSN вперемешку с другими письмами.

Сортировщик запускается по расписанию (например, раз в час по cron) и через IMAP
читает новые письма в указанном почтовом ящике. Для каждого письма определяется его
тип, и от этого зависит, какие действия будут предприняты в его отношении.

## Установка и настройка

Для работы необходимы:
* Node.js
* Redis (для хранения статистики и интеграции с mail-server)

mail-sorter может быть запущен напрямую или через написанную вами обёртку. Всё зависит от того,
в каком виде представлена база адресов. 

#### MySQL driver
Позволяет работать с типичной MySQL-базой адресов рассылки: одна строка - один адрес.
Поддерживает две операции: `update` (задать значение) или `delete` (удалить строку).
Пример конфигурации (`config.database`):
```json
{
  "type": "mysql",
  "options": {
    "connection": {
      "database": "123",
      "host": "some.hostname",
      "port": "3307",
      "user": "user",
      "password": "password"
    },
    "operation": {
      "type": "update",
      "table": "personal_accounts",
      "searchColumn": "email",
      "modifyColumn": "mailing_disabled",
      "value": 1
    }
  }
}
```

#### Mail-server database driver
Позволяет работать с базой mail-server в Redis. Пример конфигурации (`config.database`):
```json
{
  "type": "mail-server",
  "options": {
    "backend": "http://localhost:8000"
  }
}
```

#### Драйвер-аглушка
Ничего не делает, только пишет в лог. Это вариант по умолчанию, когда `config.database` не задан.
Пример конфигурации (`config.database`):
```json
{
  "type": "dummy"
}
```

#### Добавление собственных драйверов БД
mail-sorter может быть подключен как модуль (`require()`). В этом варианте можно дополнить
встроенный список драйверов БД:

```js
const mailSorter = require('path/to/mail-sorter');

class MyDatabaseClass {
  // ...
}

mailSorter.runCli({
  // позволяет писать "type": "my-database" в config.database
  'my-database': MyDatabaseClass
});
```
Это полезно для других типов баз адресов. Создание новых драйверов БД описано в конце.

### Конфигурация

Есть два файла: `config.default.json` и `config.json`. Первый содержит конфигурацию по умолчанию,
второй позволяет переопределять параметры на усмотрение пользователя. Файл `config.json` нужно
создать самостоятельно.
```js
{
  "actions": {
    "markAsRead": true, // помечать прочитанными обработанные письма
    "delete": false // удалять обработанные письма
  },
  "database": {
    // полностью передаётся в конструктор класса БД
  },
  "expungeOnClose": false, // очищать ли то, что помечено на удаление, при закрытии IMAP-соединения
  "forwardTo": "someone@example.com", // куда пересылать письма от людей
  "imapConnection": { // параметры imap-соединения
    "host": "imap.yandex.ru",
    "password": "123",
    "port": 993,
    "tls": true,
    "user": "123"
  },
  "logging": {
    "actionLogFile": "path/to/action_log", // файл для лога только с действиями. Опционально.
    "maxLogLevel": "verbose" // уровень сообщений, которые будут записываться в лог
  },
  "mailer": { // настройки smtp-сервера для пересылки сообщений
    "host": "localhost",
    "port": 587
  },
  "mailboxes": ["INBOX"], // названия почтовых ящиков, которые следует читать
  "maxForwardDays": 7, // максимальный возраст письма в днях, до которого его допустимо пересылать
  "maxTemporaryFailures": 3, // количество временных ошибок доставки, которое приведёт к исключению адреса из базы рассылок
  "messageBatchSize": 100, // по сколько писем извлекать за раз
  "readonly": true, // readonly-режим: ничего не изменять в почтовом ящике
  "redis": { // настройки Redis-соединения
    "pool": { // максимальное и минимальное количество соединений в пуле
      "min": 1,
      "max": 5
    }
  },
  "unsubscribeAdditionalAddress": "unsubscribe" // часть адреса для отписки после знака +
}
```

## Принцип работы

### Типы писем и действия для них

#### MAIL_SERVER
Ответ почтового сервера, DSN. Как правило, это письма с MIME-типом `multipart/report`
(формат, определённый в [RFC 6522](https://tools.ietf.org/html/rfc6522)),
однако сортировщик также поддерживает некоторые нестандартные форматы, которые используют
некоторые сервисы (например, mail.ru). Алгоритм действий при обнаружении такого письма:
1. Извлечь всю возможную информацию из письма: адрес получателя, статус (тип ошибки)
и (опционально) `list-id`. Сначала предпринимается попытка парсинга стандартного DSN, потом
попытка прочитать нестандартные заголовки (`x-mailer-daemon-error` и другие).
Если ни то, ни другое не увенчается успехом, то письмо **пропускается**.
2. Изменить статистику для конкретного адреса. Если ошибка постоянная (status = 5.x.x),
то просто выставляется последний статус и его дата. Если же ошибка временная (status = 4.x.x),
то дополнительно счётчик временных ошибок увеличивается на 1.
3. Если ошибка постоянная или превышено пороговое значение счётчика временных ошибок,
то адрес исключается из базы рассылок.

#### AUTORESPONDER
Письма автоответчиков. Обнаруживаются по заголовкам: `auto-submitted`, `x-autoreply`, `x-autogenerated`,
а также по наличию "autoreply" в теме письма. Такие письма просто удаляются.

#### UNSUBSCRIBE
Письма с запросом на исключение из рассылки. Обнаруживаются по части в адресе получателя после знака `+`.
По умолчанию это "unsubscribe". Пример адреса для отписки: `noreply+unsubscribe@some.domain`.
Действие: пометить получателя как отписавшегося в базе рассылки.

#### HUMAN
Письма от человека. Строго говоря, сюда попадает всё, что не удалось определить ни в одну другую категорию.
Поэтому сюда попадают письма от людей, рассылки и прочие нераспознанные форматы автоматически отправленных
писем. Письма из этой категории пересылаются на адрес, указанный в параметре конфигурации `forwardTo`.

### Действия для обработанных писем
Если письмо было успешно обработано (не возникло ошибки обработки и письмо не было явным образом **пропущено**),
то в его отношении применяются действия, указанные в объекте конфигурации `actions`:
```json
{
  "actions": {
    "callHandler": true,
    "markAsRead": true,
    "delete": false
  }
}
```
* `callHandler` - выполнить действия в соответствии с типом сообщения; установите false, чтобы не
предпринимались никакие действия.
* `delete` - удалить письмо;
* `markAsRead` - пометить прочитанным.

### База адресов рассылки

Сортировщик ничего не знает о конкретном устройстве базы адресов. Он принимает объект БД извне
и работает с ним. Объект должен реализовывать интерфейс `MailingDatabase` (описан в синтаксисе TypeScript):
```ts
interface MailingDatabase {
  // вызывается при получении DSN
  // возвращаемый boolean - признак того, что адрес удалось найти в базе
  disableEmailsForAddress (address: string, status: string, fullStatus: string): Promise<boolean>;

  // вызывается при получении письма об отписке
  // возвращаемый boolean - признак того, что адрес удалось найти в базе
  unsubscribeAddress (address: string): Promise<boolean>;
}
```