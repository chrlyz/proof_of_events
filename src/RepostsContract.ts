import { Field, SmartContract, state, State, method, UInt32 } from 'o1js';
import { RepostsProof } from './Reposts.js';
import {
  PostsContract,
  newMerkleMapRoot,
  postsContractAddress,
} from './PostsContract.js';

// ============================================================================

export class RepostsContract extends SmartContract {
  @state(Field) allRepostsCounter = State<Field>();
  @state(Field) usersRepostsCounters = State<Field>();
  @state(Field) reposts = State<Field>();

  init() {
    super.init();
    this.allRepostsCounter.set(Field(0));
    this.usersRepostsCounters.set(newMerkleMapRoot);
    this.reposts.set(newMerkleMapRoot);
  }

  @method update(proof: RepostsProof) {
    proof.verify();

    this.network.blockchainLength.assertBetween(
      UInt32.from(proof.publicInput.blockHeight),
      UInt32.from(proof.publicInput.blockHeight).add(1)
    );

    const postsContract = new PostsContract(postsContractAddress);
    const postsState = postsContract.posts.getAndAssertEquals();
    proof.publicInput.posts.assertEquals(postsState);

    const currentAllRepostsCounter =
      this.allRepostsCounter.getAndAssertEquals();
    proof.publicInput.initialAllRepostsCounter.assertEquals(
      currentAllRepostsCounter
    );

    const currentUsersRepostsCounters =
      this.usersRepostsCounters.getAndAssertEquals();
    proof.publicInput.initialUsersRepostsCounters.assertEquals(
      currentUsersRepostsCounters
    );

    const currentState = this.reposts.getAndAssertEquals();
    proof.publicInput.initialReposts.assertEquals(currentState);

    this.reposts.set(proof.publicInput.latestReposts);
    this.allRepostsCounter.set(proof.publicInput.latestAllRepostsCounter);
    this.usersRepostsCounters.set(proof.publicInput.latestUsersRepostsCounters);
  }
}
