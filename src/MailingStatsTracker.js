const FailureTypes = require('./FailureTypes');


class MailingStatsTracker {
  constructor (logger, mailingRepository, addressStatsRepository) {
    this.logger = logger;
    this.mailingRepository = mailingRepository;
    this.addressStatsRepository = addressStatsRepository;

    this.listIdToMailingId = new Map();
  }

  async countFailure (failureInfo) {
    const actions = [];
    if (failureInfo.listId) {
      await this._modifyMailingCounters(failureInfo, actions);
    }
    
    await this._modifyAddressCounters(failureInfo, actions);

    return actions;
  }

  async getTemporaryFailureCount (email) {
    const stats = await this.addressStatsRepository.getByEmail(email);
    return stats ? (stats.temporaryFailureCount || 0) : 0;
  }

  async _getMailingIdByListId (listId) {
    if (this.listIdToMailingId.has(listId)) {
      return this.listIdToMailingId.get(listId);
    }
    const mailing = this.mailingRepository && await this.mailingRepository.getByListId(listId);
    if (mailing) {
      this.listIdToMailingId.set(listId, mailing.id);
      return mailing.id;
    }
    return null;
  }

  async _modifyAddressCounters (failureInfo, actions) {
    const { diagnosticCode, dsnStatus, recipient, spam, status } = failureInfo;
    if(!this.addressStatsRepository){
        this.logger.debug(`${recipient}: not updated stats, addressStatsRepository is null`);
	return;
    }
    const stats = await this.addressStatsRepository.updateInTransaction(
      recipient, // find stats by this email
      async stats => { // if found, this will be executed as update transaction
        stats.lastStatus = dsnStatus;
        stats.lastStatusDate = new Date();
        stats.spam = spam;
        stats.diagnosticCode = diagnosticCode;
        if (status === FailureTypes.TEMPORARY_FAILURE) {
          stats.temporaryFailureCount++;
        }
      }
    );
    if (stats) {
      actions.push('updated address stats');
      this.logger.debug(`${recipient}: updated stats`);
    } else {
      await this.addressStatsRepository.create({
        email: recipient,
        lastStatus: dsnStatus,
        lastStatusDate: new Date(),
        spam, diagnosticCode
      });
      actions.push('created address stats');
    }
  }

  async _modifyMailingCounters ({ listId, message }, actions) {
    this.logger.debug(`UID ${message.uid}: list-id ${listId}`);
    const mailingId = await this._getMailingIdByListId(listId);
    if (!mailingId) {
      this.logger.debug(`UID ${message.uid}: no mailing with list-id ${listId}`);
      return;
    }
    
    const mailing = this.mailingRepository && await this.mailingRepository.updateInTransaction(
      mailingId,
      async mailing => {
        mailing.undeliveredCount++;
      }
    );
    if (mailing) {
      actions.push('updated mailing stats');
      this.logger.debug(
        `UID ${message.uid}: mailing #${mailingId} undeliveredCount = ${
          mailing.undeliveredCount
        }`
      );
    }
  }
}

module.exports = MailingStatsTracker;
