import { Mina, PrivateKey, AccountUpdate } from 'o1js';
import fs from 'fs/promises';
import { Comments } from './Comments.js';
import { CommentsContract } from './CommentsContract.js';
import { Config } from '../posts/PostsDeploy.js';

const configJson: Config = JSON.parse(await fs.readFile('config.json', 'utf8'));
const commentsConfig = configJson.deployAliases['comments'];

const feePayerKeysBase58: { privateKey: string; publicKey: string } =
  JSON.parse(await fs.readFile(commentsConfig.feepayerKeyPath, 'utf8'));
const commentsContractKeysBase58: { privateKey: string; publicKey: string } =
  JSON.parse(await fs.readFile(commentsConfig.keyPath, 'utf8'));
const feePayerKey = PrivateKey.fromBase58(feePayerKeysBase58.privateKey);
const commentsContractKey = PrivateKey.fromBase58(
  commentsContractKeysBase58.privateKey
);

const Network = Mina.Network(commentsConfig.url);
const fee = Number(commentsConfig.fee) * 1e9; // in nanomina (1 billion = 1.0 mina)
Mina.setActiveInstance(Network);
const feePayerAddress = feePayerKey.toPublicKey();
const commentsContractAddress = commentsContractKey.toPublicKey();
const commentsContract = new CommentsContract(commentsContractAddress);

console.log('Compiling Comments zkProgram...');
await Comments.compile();
console.log('Compiling commentsContract...');
await CommentsContract.compile();
console.log('Compiled');

let sentTx;
try {
  const txn = await Mina.transaction(
    { sender: feePayerAddress, fee: fee },
    async () => {
      AccountUpdate.fundNewAccount(feePayerAddress);
      commentsContract.deploy();
    }
  );
  await txn.prove();
  sentTx = await txn.sign([feePayerKey, commentsContractKey]).send();
} catch (err) {
  console.log(err);
}

if (sentTx !== undefined) {
  console.log(`
  Success! Comments deploy transaction sent.
  
  Your smart contract will be live as soon
  as the transaction is included in a block:
  https://devnet.minaexplorer.com/transaction/${sentTx.hash}
  `);
}
