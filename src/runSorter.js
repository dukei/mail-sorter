const IMAP = require('imap');
const createLogger = require('./logger');

const ReadonlyMailbox = require('./ReadonlyMailbox');
const Mailbox = require('./Mailbox');
const MailboxSorter = require('./MailboxSorter');
const MessageClassifier = require('./MessageClassifier');
const MessageTypes = require('./MessageTypes');
const HumanMessageHandler = require('./handlers/HumanMessageHandler');
const MailServerMessageHandler = require('./handlers/MailServerMessageHandler');
const AutoresponderMessageHandler = require('./handlers/AutoresponderMessageHandler');
const MailboxSorterStatsCollector = require('./MailboxSorterStatsCollector');
const UnsubscribeMessageHandler = require('./handlers/UnsubscribeMessageHandler');
const FailureInfoParser = require('./FailureInfoParser');
const DsnParser = require('./DsnParser');
const SpecialHeaderParser = require('./SpecialHeaderParser');
const MailingStatsTracker = require('./MailingStatsTracker');


/* eslint-disable max-statements */
async function run (config, logger, actionLogger, database) {
  if (!logger) {
    logger = createLogger(config.logging);
  }

  const mailboxConfig = {
    connection: new IMAP(config.imapConnection),
    expungeOnClose: config.expungeOnClose,
    readonly: config.readonly
  };
  if (config.readonly) {
    logger.info('Mailbox opened in readonly mode: no modifications will be made');
  }
  const mailbox = config.readonly ? new ReadonlyMailbox(mailboxConfig) : new Mailbox(mailboxConfig);
  logger.verbose('Connecting...');
  await mailbox.initialize();

  const redisConnectionPool = null;
  const mailingRepository = null;
  const addressStatsRepository = null;
  const sorter = createMailboxSorter({
    config, mailbox, logger, actionLogger, database, mailingRepository, addressStatsRepository
  });
  const statsCollector = new MailboxSorterStatsCollector(sorter, MessageTypes.names, logger);

  for (const boxName of config.mailboxes) {
    logger.info('Processing mailbox: ' + boxName);
    await mailbox.setBoxName(boxName);
    await sorter.sort();
  }

  statsCollector.logStats();
  await mailbox.close();
  await mailbox.end();

  logger.info('Done.');
}

module.exports = function (config, logger, actionLogger, database) {
  return run(config, logger, actionLogger, database).catch(error => {
    if (logger) {
      logger.error(error.stack);
    } else {
      // eslint-disable-next-line no-console
      console.error(error.stack);
    }
    throw error;
  });
};

function createMailboxSorter ({ 
  config, mailbox, logger, actionLogger, database, mailingRepository, addressStatsRepository
}) {
  const classifier = new MessageClassifier(config.unsubscribeAdditionalAddress);
  const failureInfoParser = new FailureInfoParser(
    new DsnParser(logger), new SpecialHeaderParser(logger)
  );
  const statsTracker = new MailingStatsTracker(logger, mailingRepository, addressStatsRepository);
  const sender = null; /*new SmtpMailSender({
    from: config.mailer.from,
    host: config.mailer.host,
    port: config.mailer.port
  }); */
  const mailingListDatabase = database;
  const handlerMap = {
    [MessageTypes.HUMAN]: new HumanMessageHandler(logger, sender, {
      forwardTo: config.forwardTo,
      maxForwardDays: config.maxForwardDays
    }),
    [MessageTypes.MAIL_SERVER]: new MailServerMessageHandler(
      mailingListDatabase, statsTracker, failureInfoParser, {
        maxTemporaryFailures: config.maxTemporaryFailures,
        readonly: config.readonly
      }
    ),
    [MessageTypes.AUTORESPONDER]: new AutoresponderMessageHandler(mailbox, logger),
    [MessageTypes.UNSUBSCRIBE]: new UnsubscribeMessageHandler(mailbox, mailingListDatabase, logger)
  };
  const actionsPerType = {};
  for (const type in config.actionsPerType) {
    if (type in MessageTypes) {
      actionsPerType[MessageTypes[type]] = config.actionsPerType[type];
    }
  }
  return new MailboxSorter(mailbox, classifier, logger, actionLogger, {
    actions: config.actions,
    actionsPerType,
    handlerMap,
    messageBatchSize: config.messageBatchSize
  });
}
