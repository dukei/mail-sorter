const mailSorter = require('./src/index.js');
class MailingDatabase {
  // called when processing DSNs
  // returns boolean - whether the address is present in database
  disableEmailsForAddress (address, status, fullStatus){
      console.log('disableEmail', address, status, fullStatus);
	}

  // called on unsubscribe mails
  // returns boolean - whether the address is present in database
  unsubscribeAddress (address){
	console.log('unsubscribe', address)
}
}

mailSorter.runCli({
  // allows to use "type": "my-database" in config.database
  'my-database': MailingDatabase
});