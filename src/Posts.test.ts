import { EventsContract } from './EventsContract';
import {
  PostsTransition,
  PostState,
  Posts,
  fieldToFlagPostsAsDeleted,
} from './Posts';
import {
  Field,
  Mina,
  PrivateKey,
  PublicKey,
  AccountUpdate,
  Poseidon,
  Signature,
  MerkleMap,
  Bool,
} from 'snarkyjs';

let proofsEnabled = true;

describe(`the 'EventsContract' and the 'Posts' zkProgram`, () => {
  let deployerAccount: PublicKey,
    deployerKey: PrivateKey,
    senderAccount: PublicKey,
    senderKey: PrivateKey,
    zkAppAddress: PublicKey,
    zkAppPrivateKey: PrivateKey,
    zkApp: EventsContract,
    postsTree: MerkleMap,
    Local: ReturnType<typeof Mina.LocalBlockchain>;

  beforeAll(async () => {
    await Posts.compile();
    if (proofsEnabled) await EventsContract.compile();
  });

  beforeEach(() => {
    Local = Mina.LocalBlockchain({ proofsEnabled });
    Mina.setActiveInstance(Local);
    ({ privateKey: deployerKey, publicKey: deployerAccount } =
      Local.testAccounts[0]);
    ({ privateKey: senderKey, publicKey: senderAccount } =
      Local.testAccounts[1]);
    zkAppPrivateKey = PrivateKey.random();
    zkAppAddress = zkAppPrivateKey.toPublicKey();
    zkApp = new EventsContract(zkAppAddress);
    postsTree = new MerkleMap();
  });

  async function localDeploy() {
    const txn = await Mina.transaction(deployerAccount, () => {
      AccountUpdate.fundNewAccount(deployerAccount);
      zkApp.deploy();
    });
    await txn.prove();
    await txn.sign([deployerKey, zkAppPrivateKey]).send();
  }

  function createPostsTransitionValidInputs(
    userAccount: PublicKey,
    userKey: PrivateKey,
    hashedPost: Field,
    postNumber: Field,
    blockHeight: Field
  ) {
    const signature = Signature.create(userKey, [hashedPost]);
    const initialPostsRoot = postsTree.getRoot();
    const postKey = Poseidon.hash(userAccount.toFields().concat(hashedPost));
    const postWitness = postsTree.getWitness(postKey);

    const postState = new PostState({
      postNumber: postNumber,
      blockHeight: blockHeight,
      deletedPost: Bool(false),
      deletedAtBlockHeight: Field(0),
    });

    postsTree.set(postKey, postState.hash());
    const latestPostsRoot = postsTree.getRoot();

    return {
      signature: signature,
      userAddress: userAccount,
      hashedPost: hashedPost,

      initialPostsRoot: initialPostsRoot,
      latestPostsRoot: latestPostsRoot,
      postWitness: postWitness,

      postState: postState,
    };
  }

  function createPostDeletionTransitionValidInputs(
    userAccount: PublicKey,
    userKey: PrivateKey,
    hashedPost: Field,
    initialPostState: PostState,
    blockHeight: Field
  ) {
    const signature = Signature.create(userKey, [
      hashedPost,
      fieldToFlagPostsAsDeleted,
    ]);
    const initialPostsRoot = postsTree.getRoot();
    const postKey = Poseidon.hash(userAccount.toFields().concat(hashedPost));
    const postWitness = postsTree.getWitness(postKey);

    const latestPostState = new PostState({
      postNumber: initialPostState.postNumber,
      blockHeight: initialPostState.blockHeight,
      deletedPost: Bool(true),
      deletedAtBlockHeight: blockHeight,
    });

    postsTree.set(postKey, latestPostState.hash());
    const latestPostsRoot = postsTree.getRoot();

    return {
      signature: signature,
      userAddress: userAccount,
      hashedPost: hashedPost,

      initialPostsRoot: initialPostsRoot,
      latestPostsRoot: latestPostsRoot,
      postWitness: postWitness,

      postState: initialPostState,
    };
  }

  it(`generates and deploys the 'EventsContract'`, async () => {
    await localDeploy();
    const currentPostsRoot = zkApp.posts.get();
    const currentPostsNumber = zkApp.postsNumber.get();
    const postsRoot = postsTree.getRoot();

    expect(currentPostsRoot).toEqual(postsRoot);
    expect(currentPostsNumber).toEqual(Field(0));
  });

  it(`updates the state of the 'EventsContract', when publishing a post`, async () => {
    await localDeploy();

    let currentPostsRoot = zkApp.posts.get();
    let currentPostsNumber = zkApp.postsNumber.get();
    const postsRoot = postsTree.getRoot();
    expect(currentPostsRoot).toEqual(postsRoot);
    expect(currentPostsNumber).toEqual(Field(0));

    const valid = createPostsTransitionValidInputs(
      senderAccount,
      senderKey,
      Field(777),
      Field(1),
      Field(1)
    );

    const transition = PostsTransition.createPostsTransition(
      valid.signature,
      senderAccount,
      valid.hashedPost,
      valid.initialPostsRoot,
      valid.latestPostsRoot,
      valid.postWitness,
      valid.postState.postNumber.sub(1),
      valid.postState
    );

    const proof = await Posts.provePostsTransition(
      transition,
      valid.signature,
      senderAccount,
      valid.hashedPost,
      valid.initialPostsRoot,
      valid.latestPostsRoot,
      valid.postWitness,
      valid.postState.postNumber.sub(1),
      valid.postState
    );

    const txn = await Mina.transaction(senderAccount, () => {
      zkApp.update(proof);
    });

    await txn.prove();
    await txn.sign([senderKey]).send();

    currentPostsRoot = zkApp.posts.get();
    currentPostsNumber = zkApp.postsNumber.get();
    expect(currentPostsRoot).toEqual(valid.latestPostsRoot);
    expect(currentPostsNumber).toEqual(Field(1));
  });

  test(`if 'transition' and 'computedTransition' mismatch,\
  'Posts.provePostsTransition()' throws 'Constraint unsatisfied' error`, async () => {
    const valid = createPostsTransitionValidInputs(
      senderAccount,
      senderKey,
      Field(777),
      Field(1),
      Field(1)
    );

    const transition = new PostsTransition({
      initialPostsRoot: Field(111),
      latestPostsRoot: valid.latestPostsRoot,
      initialPostsNumber: valid.postState.postNumber.sub(1),
      latestPostsNumber: valid.postState.postNumber,
      blockHeight: valid.postState.blockHeight,
    });

    await expect(async () => {
      const proof = await Posts.provePostsTransition(
        transition,
        valid.signature,
        senderAccount,
        valid.hashedPost,
        valid.initialPostsRoot,
        valid.latestPostsRoot,
        valid.postWitness,
        valid.postState.postNumber.sub(1),
        valid.postState
      );
    }).rejects.toThrowError(`Constraint unsatisfied (unreduced)`);
  });

  test(`if 'postState.blockHeight' and 'currentSlot' at the moment of\
  transaction inclusion mismatch, 'EventsContract.update()' throws\
  'Valid_while_precondition_unsatisfied' error`, async () => {
    await localDeploy();

    const valid = createPostsTransitionValidInputs(
      senderAccount,
      senderKey,
      Field(777),
      Field(1),
      Field(2)
    );

    const transition = PostsTransition.createPostsTransition(
      valid.signature,
      senderAccount,
      valid.hashedPost,
      valid.initialPostsRoot,
      valid.latestPostsRoot,
      valid.postWitness,
      valid.postState.postNumber.sub(1),
      valid.postState
    );

    const proof = await Posts.provePostsTransition(
      transition,
      valid.signature,
      senderAccount,
      valid.hashedPost,
      valid.initialPostsRoot,
      valid.latestPostsRoot,
      valid.postWitness,
      valid.postState.postNumber.sub(1),
      valid.postState
    );

    const txn = await Mina.transaction(senderAccount, () => {
      zkApp.update(proof);
    });

    await txn.prove();

    await expect(async () => {
      await txn.sign([senderKey]).send();
    }).rejects.toThrowError(`Valid_while_precondition_unsatisfied`);
  });

  test(`if 'hashedPost' is signed by a different account,\
  the signature for 'hashedPost' is invalid in 'createPostsTransition()'`, async () => {
    const valid = createPostsTransitionValidInputs(
      senderAccount,
      senderKey,
      Field(777),
      Field(1),
      Field(1)
    );

    expect(() => {
      PostsTransition.createPostsTransition(
        valid.signature,
        PrivateKey.random().toPublicKey(),
        valid.hashedPost,
        valid.initialPostsRoot,
        valid.latestPostsRoot,
        valid.postWitness,
        valid.postState.postNumber.sub(1),
        valid.postState
      );
    }).toThrowError(`Bool.assertTrue()`);
  });

  test(`if 'signature' is invalid for 'hashedPost',\
  'createPostsTransition()' throws a 'Bool.assertTrue()' error`, async () => {
    const valid = createPostsTransitionValidInputs(
      senderAccount,
      senderKey,
      Field(777),
      Field(1),
      Field(1)
    );

    expect(() => {
      PostsTransition.createPostsTransition(
        valid.signature,
        senderAccount,
        Field(111),
        valid.initialPostsRoot,
        valid.latestPostsRoot,
        valid.postWitness,
        valid.postState.postNumber.sub(1),
        valid.postState
      );
    }).toThrowError(`Bool.assertTrue()`);
  });

  test(`if 'initialPostsRoot' and the root derived from 'postWitness' mismatch,\
  'createPostsTransition()' throws a 'Field.assertEquals()' error`, async () => {
    const valid = createPostsTransitionValidInputs(
      senderAccount,
      senderKey,
      Field(777),
      Field(1),
      Field(1)
    );

    expect(() => {
      PostsTransition.createPostsTransition(
        valid.signature,
        senderAccount,
        valid.hashedPost,
        Field(111),
        valid.latestPostsRoot,
        valid.postWitness,
        valid.postState.postNumber.sub(1),
        valid.postState
      );
    }).toThrowError(`Field.assertEquals()`);
  });

  test(`if 'latestPostsRoot' and the updated root mismatch,\
  'createPostsTransition()' throws a 'Field.assertEquals()' error`, async () => {
    const valid = createPostsTransitionValidInputs(
      senderAccount,
      senderKey,
      Field(777),
      Field(1),
      Field(1)
    );

    expect(() => {
      PostsTransition.createPostsTransition(
        valid.signature,
        senderAccount,
        valid.hashedPost,
        valid.initialPostsRoot,
        Field(111),
        valid.postWitness,
        valid.postState.postNumber.sub(1),
        valid.postState
      );
    }).toThrowError(`Field.assertEquals()`);
  });

  test(`if the key derived from 'postWitness' and the hash derived from 'userAddress'\
   and hashedPost mismatch, 'createPostsTransition()' throws a 'Field.assertEquals()' error'`, async () => {
    const wrongPostWitness = postsTree.getWitness(
      Poseidon.hash(deployerAccount.toFields().concat(Field(777)))
    );

    const valid = createPostsTransitionValidInputs(
      senderAccount,
      senderKey,
      Field(777),
      Field(1),
      Field(1)
    );

    expect(() => {
      PostsTransition.createPostsTransition(
        valid.signature,
        senderAccount,
        valid.hashedPost,
        valid.initialPostsRoot,
        valid.latestPostsRoot,
        wrongPostWitness,
        valid.postState.postNumber.sub(1),
        valid.postState
      );
    }).toThrowError(`Field.assertEquals()`);
  });

  test(`if 'initialPostsNumber' is not equal to 'postState.postNumber' minus one,\
  'createPostsTransition()' throws a 'Field.assertEquals()' error`, async () => {
    const valid = createPostsTransitionValidInputs(
      senderAccount,
      senderKey,
      Field(777),
      Field(1),
      Field(1)
    );

    expect(() => {
      PostsTransition.createPostsTransition(
        valid.signature,
        senderAccount,
        valid.hashedPost,
        valid.initialPostsRoot,
        valid.latestPostsRoot,
        valid.postWitness,
        valid.postState.postNumber,
        valid.postState
      );
    }).toThrowError(`Field.assertEquals()`);
  });

  test(`if 'postState' doesn't generate a root equal to 'latestPostsRoot',\
  'createPostsTransition()' throws a 'Field.assertEquals()' error`, async () => {
    const valid = createPostsTransitionValidInputs(
      senderAccount,
      senderKey,
      Field(777),
      Field(1),
      Field(1)
    );

    expect(() => {
      PostsTransition.createPostsTransition(
        valid.signature,
        senderAccount,
        valid.hashedPost,
        valid.initialPostsRoot,
        valid.latestPostsRoot,
        valid.postWitness,
        valid.postState.postNumber.sub(1),
        new PostState({
          postNumber: Field(2),
          blockHeight: Field(2),
          deletedPost: Bool(false),
          deletedAtBlockHeight: Field(0),
        })
      );
    }).toThrowError(`Field.assertEquals()`);
  });

  test(`if the post already exists, 'createPostsTransition()' throws\
  a 'Field.assertEquals()' error`, async () => {
    const hashedPost = Field(777);
    const postState = new PostState({
      postNumber: Field(1),
      blockHeight: Field(1),
      deletedPost: Bool(false),
      deletedAtBlockHeight: Field(0),
    });
    postsTree.set(
      Poseidon.hash(senderAccount.toFields().concat(hashedPost)),
      postState.hash()
    );
    const initialPostsRoot = postsTree.getRoot();

    const valid = createPostsTransitionValidInputs(
      senderAccount,
      senderKey,
      hashedPost,
      Field(1),
      Field(1)
    );

    expect(() => {
      PostsTransition.createPostsTransition(
        valid.signature,
        senderAccount,
        valid.hashedPost,
        initialPostsRoot,
        valid.latestPostsRoot,
        valid.postWitness,
        valid.postState.postNumber.sub(1),
        valid.postState
      );
    }).toThrowError(`Field.assertEquals()`);
  });

  it(`merges 'PostsTransition' proofs`, async () => {
    await localDeploy();

    let currentPostsRoot = zkApp.posts.get();
    let currentPostsNumber = zkApp.postsNumber.get();
    const postsRoot = postsTree.getRoot();
    expect(currentPostsRoot).toEqual(postsRoot);
    expect(currentPostsNumber).toEqual(Field(0));

    const valid1 = createPostsTransitionValidInputs(
      senderAccount,
      senderKey,
      Field(777),
      Field(1),
      Field(1)
    );
    const transition1 = PostsTransition.createPostsTransition(
      valid1.signature,
      senderAccount,
      valid1.hashedPost,
      valid1.initialPostsRoot,
      valid1.latestPostsRoot,
      valid1.postWitness,
      valid1.postState.postNumber.sub(1),
      valid1.postState
    );
    const proof1 = await Posts.provePostsTransition(
      transition1,
      valid1.signature,
      senderAccount,
      valid1.hashedPost,
      valid1.initialPostsRoot,
      valid1.latestPostsRoot,
      valid1.postWitness,
      valid1.postState.postNumber.sub(1),
      valid1.postState
    );

    const valid2 = createPostsTransitionValidInputs(
      senderAccount,
      senderKey,
      Field(212),
      Field(2),
      Field(1)
    );
    const transition2 = PostsTransition.createPostsTransition(
      valid2.signature,
      senderAccount,
      valid2.hashedPost,
      valid2.initialPostsRoot,
      valid2.latestPostsRoot,
      valid2.postWitness,
      valid2.postState.postNumber.sub(1),
      valid2.postState
    );
    const proof2 = await Posts.provePostsTransition(
      transition2,
      valid2.signature,
      senderAccount,
      valid2.hashedPost,
      valid2.initialPostsRoot,
      valid2.latestPostsRoot,
      valid2.postWitness,
      valid2.postState.postNumber.sub(1),
      valid2.postState
    );

    const mergedTransitions = PostsTransition.mergePostsTransitions(
      transition1,
      transition2
    );

    const mergedTransitionsProof = await Posts.proveMergedPostsTransitions(
      mergedTransitions,
      proof1,
      proof2
    );

    const txn = await Mina.transaction(senderAccount, () => {
      zkApp.update(mergedTransitionsProof);
    });

    await txn.prove();
    await txn.sign([senderKey]).send();

    currentPostsRoot = zkApp.posts.get();
    currentPostsNumber = zkApp.postsNumber.get();
    expect(currentPostsRoot).toEqual(valid2.latestPostsRoot);
    expect(currentPostsNumber).toEqual(Field(2));
  });

  it(`it merges 'PostsTransition' proofs from 2 different users`, async () => {
    await localDeploy();

    let currentPostsRoot = zkApp.posts.get();
    let currentPostsNumber = zkApp.postsNumber.get();
    const postsRoot = postsTree.getRoot();
    expect(currentPostsRoot).toEqual(postsRoot);
    expect(currentPostsNumber).toEqual(Field(0));

    const valid1 = createPostsTransitionValidInputs(
      senderAccount,
      senderKey,
      Field(777),
      Field(1),
      Field(1)
    );
    const transition1 = PostsTransition.createPostsTransition(
      valid1.signature,
      senderAccount,
      valid1.hashedPost,
      valid1.initialPostsRoot,
      valid1.latestPostsRoot,
      valid1.postWitness,
      valid1.postState.postNumber.sub(1),
      valid1.postState
    );
    const proof1 = await Posts.provePostsTransition(
      transition1,
      valid1.signature,
      senderAccount,
      valid1.hashedPost,
      valid1.initialPostsRoot,
      valid1.latestPostsRoot,
      valid1.postWitness,
      valid1.postState.postNumber.sub(1),
      valid1.postState
    );

    const valid2 = createPostsTransitionValidInputs(
      deployerAccount,
      deployerKey,
      Field(212),
      Field(2),
      Field(1)
    );
    const transition2 = PostsTransition.createPostsTransition(
      valid2.signature,
      deployerAccount,
      valid2.hashedPost,
      valid2.initialPostsRoot,
      valid2.latestPostsRoot,
      valid2.postWitness,
      valid2.postState.postNumber.sub(1),
      valid2.postState
    );
    const proof2 = await Posts.provePostsTransition(
      transition2,
      valid2.signature,
      deployerAccount,
      valid2.hashedPost,
      valid2.initialPostsRoot,
      valid2.latestPostsRoot,
      valid2.postWitness,
      valid2.postState.postNumber.sub(1),
      valid2.postState
    );

    const mergedTransitions = PostsTransition.mergePostsTransitions(
      transition1,
      transition2
    );

    const mergedTransitionsProof = await Posts.proveMergedPostsTransitions(
      mergedTransitions,
      proof1,
      proof2
    );

    const txn = await Mina.transaction(senderAccount, () => {
      zkApp.update(mergedTransitionsProof);
    });

    await txn.prove();
    await txn.sign([senderKey]).send();

    currentPostsRoot = zkApp.posts.get();
    currentPostsNumber = zkApp.postsNumber.get();
    expect(currentPostsRoot).toEqual(valid2.latestPostsRoot);
    expect(currentPostsNumber).toEqual(Field(2));
  });

  test(`if 'latestPostsRoot' of 'postsTransition1Proof' and 'initialPostsRoot'\
  of 'postsTransition2Proof' mismatch, 'proveMergedPostsTransitions()' throws\
  'Constraint unsatisfied' error`, async () => {
    const valid1 = createPostsTransitionValidInputs(
      senderAccount,
      senderKey,
      Field(777),
      Field(1),
      Field(1)
    );
    const transition1 = PostsTransition.createPostsTransition(
      valid1.signature,
      senderAccount,
      valid1.hashedPost,
      valid1.initialPostsRoot,
      valid1.latestPostsRoot,
      valid1.postWitness,
      valid1.postState.postNumber.sub(1),
      valid1.postState
    );
    const proof1 = await Posts.provePostsTransition(
      transition1,
      valid1.signature,
      senderAccount,
      valid1.hashedPost,
      valid1.initialPostsRoot,
      valid1.latestPostsRoot,
      valid1.postWitness,
      valid1.postState.postNumber.sub(1),
      valid1.postState
    );

    const divergentPostsTree = new MerkleMap();
    const divergentInitialPostsRoot = divergentPostsTree.getRoot();
    const hashedPost = Field(212);
    const postKey = Poseidon.hash(
      deployerAccount.toFields().concat(hashedPost)
    );
    const divergentPostWitness = divergentPostsTree.getWitness(postKey);
    const signature = Signature.create(deployerKey, [hashedPost]);
    const postState = new PostState({
      postNumber: Field(2),
      blockHeight: Field(1),
      deletedPost: Bool(false),
      deletedAtBlockHeight: Field(0),
    });
    divergentPostsTree.set(postKey, postState.hash());
    const divergentLatestPostsRoot = divergentPostsTree.getRoot();

    const divergentTransition2 = PostsTransition.createPostsTransition(
      signature,
      deployerAccount,
      hashedPost,
      divergentInitialPostsRoot,
      divergentLatestPostsRoot,
      divergentPostWitness,
      postState.postNumber.sub(1),
      postState
    );
    const proof2 = await Posts.provePostsTransition(
      divergentTransition2,
      signature,
      deployerAccount,
      hashedPost,
      divergentInitialPostsRoot,
      divergentLatestPostsRoot,
      divergentPostWitness,
      postState.postNumber.sub(1),
      postState
    );

    const mergedTransitions = new PostsTransition({
      initialPostsRoot: valid1.initialPostsRoot,
      latestPostsRoot: divergentLatestPostsRoot,
      initialPostsNumber: valid1.postState.postNumber.sub(1),
      latestPostsNumber: postState.postNumber,
      blockHeight: postState.blockHeight,
    });

    await expect(async () => {
      await Posts.proveMergedPostsTransitions(
        mergedTransitions,
        proof1,
        proof2
      );
    }).rejects.toThrowError(`Constraint unsatisfied (unreduced)`);
  });

  test(`if 'initialPostsRoot' of 'postsTransition1Proof' and 'initialPostsRoot'\
  of 'mergedPostsTransitions' mismatch, 'proveMergedPostsTransitions()' throws\
  'Constraint unsatisfied' error`, async () => {
    const valid1 = createPostsTransitionValidInputs(
      senderAccount,
      senderKey,
      Field(777),
      Field(1),
      Field(1)
    );
    const transition1 = PostsTransition.createPostsTransition(
      valid1.signature,
      senderAccount,
      valid1.hashedPost,
      valid1.initialPostsRoot,
      valid1.latestPostsRoot,
      valid1.postWitness,
      valid1.postState.postNumber.sub(1),
      valid1.postState
    );
    const proof1 = await Posts.provePostsTransition(
      transition1,
      valid1.signature,
      senderAccount,
      valid1.hashedPost,
      valid1.initialPostsRoot,
      valid1.latestPostsRoot,
      valid1.postWitness,
      valid1.postState.postNumber.sub(1),
      valid1.postState
    );

    const valid2 = createPostsTransitionValidInputs(
      deployerAccount,
      deployerKey,
      Field(212),
      Field(2),
      Field(1)
    );
    const transition2 = PostsTransition.createPostsTransition(
      valid2.signature,
      deployerAccount,
      valid2.hashedPost,
      valid2.initialPostsRoot,
      valid2.latestPostsRoot,
      valid2.postWitness,
      valid2.postState.postNumber.sub(1),
      valid2.postState
    );
    const proof2 = await Posts.provePostsTransition(
      transition2,
      valid2.signature,
      deployerAccount,
      valid2.hashedPost,
      valid2.initialPostsRoot,
      valid2.latestPostsRoot,
      valid2.postWitness,
      valid2.postState.postNumber.sub(1),
      valid2.postState
    );

    const mergedTransitions = new PostsTransition({
      initialPostsRoot: Field(111),
      latestPostsRoot: valid2.latestPostsRoot,
      initialPostsNumber: valid1.postState.postNumber.sub(1),
      latestPostsNumber: valid2.postState.postNumber,
      blockHeight: valid2.postState.blockHeight,
    });

    await expect(async () => {
      await Posts.proveMergedPostsTransitions(
        mergedTransitions,
        proof1,
        proof2
      );
    }).rejects.toThrowError(`Constraint unsatisfied (unreduced)`);
  });

  test(`if 'latestPostsRoot' of 'postsTransition2Proof'  and 'latestPostsRoot'\
  of 'mergedPostsTransitions' mismatch, 'provePostsTransition()' throws\
  'Constraint unsatisfied' error`, async () => {
    const valid1 = createPostsTransitionValidInputs(
      senderAccount,
      senderKey,
      Field(777),
      Field(1),
      Field(1)
    );
    const transition1 = PostsTransition.createPostsTransition(
      valid1.signature,
      senderAccount,
      valid1.hashedPost,
      valid1.initialPostsRoot,
      valid1.latestPostsRoot,
      valid1.postWitness,
      valid1.postState.postNumber.sub(1),
      valid1.postState
    );
    const proof1 = await Posts.provePostsTransition(
      transition1,
      valid1.signature,
      senderAccount,
      valid1.hashedPost,
      valid1.initialPostsRoot,
      valid1.latestPostsRoot,
      valid1.postWitness,
      valid1.postState.postNumber.sub(1),
      valid1.postState
    );

    const valid2 = createPostsTransitionValidInputs(
      deployerAccount,
      deployerKey,
      Field(212),
      Field(2),
      Field(1)
    );
    const transition2 = PostsTransition.createPostsTransition(
      valid2.signature,
      deployerAccount,
      valid2.hashedPost,
      valid2.initialPostsRoot,
      valid2.latestPostsRoot,
      valid2.postWitness,
      valid2.postState.postNumber.sub(1),
      valid2.postState
    );
    const proof2 = await Posts.provePostsTransition(
      transition2,
      valid2.signature,
      deployerAccount,
      valid2.hashedPost,
      valid2.initialPostsRoot,
      valid2.latestPostsRoot,
      valid2.postWitness,
      valid2.postState.postNumber.sub(1),
      valid2.postState
    );

    const mergedTransitions = new PostsTransition({
      initialPostsRoot: valid1.initialPostsRoot,
      latestPostsRoot: Field(111),
      initialPostsNumber: valid1.postState.postNumber.sub(1),
      latestPostsNumber: valid2.postState.postNumber,
      blockHeight: valid2.postState.blockHeight,
    });

    await expect(async () => {
      await Posts.proveMergedPostsTransitions(
        mergedTransitions,
        proof1,
        proof2
      );
    }).rejects.toThrowError(`Constraint unsatisfied (unreduced)`);
  });

  test(`if 'latestPostsNumber' of 'postsTransition1Proof' and 'initialPostsNumber'\
  of 'postsTransition2Proof' mismatch, 'provePostsTransition()' throws\
  'Constraint unsatisfied' error`, async () => {
    const valid1 = createPostsTransitionValidInputs(
      senderAccount,
      senderKey,
      Field(777),
      Field(1),
      Field(1)
    );
    const transition1 = PostsTransition.createPostsTransition(
      valid1.signature,
      senderAccount,
      valid1.hashedPost,
      valid1.initialPostsRoot,
      valid1.latestPostsRoot,
      valid1.postWitness,
      valid1.postState.postNumber.sub(1),
      valid1.postState
    );
    const proof1 = await Posts.provePostsTransition(
      transition1,
      valid1.signature,
      senderAccount,
      valid1.hashedPost,
      valid1.initialPostsRoot,
      valid1.latestPostsRoot,
      valid1.postWitness,
      valid1.postState.postNumber.sub(1),
      valid1.postState
    );

    const valid2 = createPostsTransitionValidInputs(
      deployerAccount,
      deployerKey,
      Field(212),
      Field(1),
      Field(1)
    );
    const transition2 = PostsTransition.createPostsTransition(
      valid2.signature,
      deployerAccount,
      valid2.hashedPost,
      valid2.initialPostsRoot,
      valid2.latestPostsRoot,
      valid2.postWitness,
      valid2.postState.postNumber.sub(1),
      valid2.postState
    );
    const proof2 = await Posts.provePostsTransition(
      transition2,
      valid2.signature,
      deployerAccount,
      valid2.hashedPost,
      valid2.initialPostsRoot,
      valid2.latestPostsRoot,
      valid2.postWitness,
      valid2.postState.postNumber.sub(1),
      valid2.postState
    );

    const mergedTransitions = new PostsTransition({
      initialPostsRoot: valid1.initialPostsRoot,
      latestPostsRoot: valid2.latestPostsRoot,
      initialPostsNumber: valid1.postState.postNumber.sub(1),
      latestPostsNumber: valid2.postState.postNumber,
      blockHeight: valid2.postState.blockHeight,
    });

    await expect(async () => {
      await Posts.proveMergedPostsTransitions(
        mergedTransitions,
        proof1,
        proof2
      );
    }).rejects.toThrowError(`Constraint unsatisfied (unreduced)`);
  });

  test(`if 'initialPostsNumber' of 'postsTransition1Proof' and 'initialPostsNumber'\
  of 'mergedPostsTransitions' mismatch, 'provePostsTransition()' throws\
  'Constraint unsatisfied' error`, async () => {
    const valid1 = createPostsTransitionValidInputs(
      senderAccount,
      senderKey,
      Field(777),
      Field(1),
      Field(1)
    );
    const transition1 = PostsTransition.createPostsTransition(
      valid1.signature,
      senderAccount,
      valid1.hashedPost,
      valid1.initialPostsRoot,
      valid1.latestPostsRoot,
      valid1.postWitness,
      valid1.postState.postNumber.sub(1),
      valid1.postState
    );
    const proof1 = await Posts.provePostsTransition(
      transition1,
      valid1.signature,
      senderAccount,
      valid1.hashedPost,
      valid1.initialPostsRoot,
      valid1.latestPostsRoot,
      valid1.postWitness,
      valid1.postState.postNumber.sub(1),
      valid1.postState
    );

    const valid2 = createPostsTransitionValidInputs(
      deployerAccount,
      deployerKey,
      Field(212),
      Field(2),
      Field(1)
    );
    const transition2 = PostsTransition.createPostsTransition(
      valid2.signature,
      deployerAccount,
      valid2.hashedPost,
      valid2.initialPostsRoot,
      valid2.latestPostsRoot,
      valid2.postWitness,
      valid2.postState.postNumber.sub(1),
      valid2.postState
    );
    const proof2 = await Posts.provePostsTransition(
      transition2,
      valid2.signature,
      deployerAccount,
      valid2.hashedPost,
      valid2.initialPostsRoot,
      valid2.latestPostsRoot,
      valid2.postWitness,
      valid2.postState.postNumber.sub(1),
      valid2.postState
    );

    const mergedTransitions = new PostsTransition({
      initialPostsRoot: valid1.initialPostsRoot,
      latestPostsRoot: valid2.latestPostsRoot,
      initialPostsNumber: Field(6),
      latestPostsNumber: valid2.postState.postNumber,
      blockHeight: valid2.postState.blockHeight,
    });

    await expect(async () => {
      await Posts.proveMergedPostsTransitions(
        mergedTransitions,
        proof1,
        proof2
      );
    }).rejects.toThrowError(`Constraint unsatisfied (unreduced)`);
  });

  test(`if 'latestPostsNumber' of 'postsTransition2Proof' and 'latestPostsNumber'\
  of 'mergedPostsTransitions' mismatch, 'provePostsTransition()' throws\
  'Constraint unsatisfied' error`, async () => {
    const valid1 = createPostsTransitionValidInputs(
      senderAccount,
      senderKey,
      Field(777),
      Field(1),
      Field(1)
    );
    const transition1 = PostsTransition.createPostsTransition(
      valid1.signature,
      senderAccount,
      valid1.hashedPost,
      valid1.initialPostsRoot,
      valid1.latestPostsRoot,
      valid1.postWitness,
      valid1.postState.postNumber.sub(1),
      valid1.postState
    );
    const proof1 = await Posts.provePostsTransition(
      transition1,
      valid1.signature,
      senderAccount,
      valid1.hashedPost,
      valid1.initialPostsRoot,
      valid1.latestPostsRoot,
      valid1.postWitness,
      valid1.postState.postNumber.sub(1),
      valid1.postState
    );

    const valid2 = createPostsTransitionValidInputs(
      deployerAccount,
      deployerKey,
      Field(212),
      Field(2),
      Field(1)
    );
    const transition2 = PostsTransition.createPostsTransition(
      valid2.signature,
      deployerAccount,
      valid2.hashedPost,
      valid2.initialPostsRoot,
      valid2.latestPostsRoot,
      valid2.postWitness,
      valid2.postState.postNumber.sub(1),
      valid2.postState
    );
    const proof2 = await Posts.provePostsTransition(
      transition2,
      valid2.signature,
      deployerAccount,
      valid2.hashedPost,
      valid2.initialPostsRoot,
      valid2.latestPostsRoot,
      valid2.postWitness,
      valid2.postState.postNumber.sub(1),
      valid2.postState
    );

    const mergedTransitions = new PostsTransition({
      initialPostsRoot: valid1.initialPostsRoot,
      latestPostsRoot: valid2.latestPostsRoot,
      initialPostsNumber: valid1.postState.postNumber.sub(1),
      latestPostsNumber: Field(6),
      blockHeight: valid2.postState.blockHeight,
    });

    await expect(async () => {
      await Posts.proveMergedPostsTransitions(
        mergedTransitions,
        proof1,
        proof2
      );
    }).rejects.toThrowError(`Constraint unsatisfied (unreduced)`);
  });

  test(`if 'blockHeight' of 'postsTransition1Proof' and 'blockHeight'\
  of 'mergedPostsTransitions' mismatch, 'provePostsTransition()' throws\
  'Constraint unsatisfied' error`, async () => {
    const valid1 = createPostsTransitionValidInputs(
      senderAccount,
      senderKey,
      Field(777),
      Field(1),
      Field(6)
    );
    const transition1 = PostsTransition.createPostsTransition(
      valid1.signature,
      senderAccount,
      valid1.hashedPost,
      valid1.initialPostsRoot,
      valid1.latestPostsRoot,
      valid1.postWitness,
      valid1.postState.postNumber.sub(1),
      valid1.postState
    );
    const proof1 = await Posts.provePostsTransition(
      transition1,
      valid1.signature,
      senderAccount,
      valid1.hashedPost,
      valid1.initialPostsRoot,
      valid1.latestPostsRoot,
      valid1.postWitness,
      valid1.postState.postNumber.sub(1),
      valid1.postState
    );

    const valid2 = createPostsTransitionValidInputs(
      deployerAccount,
      deployerKey,
      Field(212),
      Field(2),
      Field(5)
    );
    const transition2 = PostsTransition.createPostsTransition(
      valid2.signature,
      deployerAccount,
      valid2.hashedPost,
      valid2.initialPostsRoot,
      valid2.latestPostsRoot,
      valid2.postWitness,
      valid2.postState.postNumber.sub(1),
      valid2.postState
    );
    const proof2 = await Posts.provePostsTransition(
      transition2,
      valid2.signature,
      deployerAccount,
      valid2.hashedPost,
      valid2.initialPostsRoot,
      valid2.latestPostsRoot,
      valid2.postWitness,
      valid2.postState.postNumber.sub(1),
      valid2.postState
    );

    const mergedTransitions = new PostsTransition({
      initialPostsRoot: valid1.initialPostsRoot,
      latestPostsRoot: valid2.latestPostsRoot,
      initialPostsNumber: valid1.postState.postNumber.sub(1),
      latestPostsNumber: valid2.postState.postNumber,
      blockHeight: Field(5),
    });

    await expect(async () => {
      await Posts.proveMergedPostsTransitions(
        mergedTransitions,
        proof1,
        proof2
      );
    }).rejects.toThrowError(`Constraint unsatisfied (unreduced)`);
  });

  test(`if 'blockHeight' of 'postsTransition2Proof' and 'blockHeight'\
  of 'mergedPostsTransitions' mismatch, 'provePostsTransition()' throws\
  'Constraint unsatisfied' error`, async () => {
    const valid1 = createPostsTransitionValidInputs(
      senderAccount,
      senderKey,
      Field(777),
      Field(1),
      Field(7)
    );
    const transition1 = PostsTransition.createPostsTransition(
      valid1.signature,
      senderAccount,
      valid1.hashedPost,
      valid1.initialPostsRoot,
      valid1.latestPostsRoot,
      valid1.postWitness,
      valid1.postState.postNumber.sub(1),
      valid1.postState
    );
    const proof1 = await Posts.provePostsTransition(
      transition1,
      valid1.signature,
      senderAccount,
      valid1.hashedPost,
      valid1.initialPostsRoot,
      valid1.latestPostsRoot,
      valid1.postWitness,
      valid1.postState.postNumber.sub(1),
      valid1.postState
    );

    const valid2 = createPostsTransitionValidInputs(
      deployerAccount,
      deployerKey,
      Field(212),
      Field(2),
      Field(6)
    );
    const transition2 = PostsTransition.createPostsTransition(
      valid2.signature,
      deployerAccount,
      valid2.hashedPost,
      valid2.initialPostsRoot,
      valid2.latestPostsRoot,
      valid2.postWitness,
      valid2.postState.postNumber.sub(1),
      valid2.postState
    );
    const proof2 = await Posts.provePostsTransition(
      transition2,
      valid2.signature,
      deployerAccount,
      valid2.hashedPost,
      valid2.initialPostsRoot,
      valid2.latestPostsRoot,
      valid2.postWitness,
      valid2.postState.postNumber.sub(1),
      valid2.postState
    );

    const mergedTransitions = new PostsTransition({
      initialPostsRoot: valid1.initialPostsRoot,
      latestPostsRoot: valid2.latestPostsRoot,
      initialPostsNumber: valid1.postState.postNumber.sub(1),
      latestPostsNumber: valid2.postState.postNumber,
      blockHeight: Field(7),
    });

    await expect(async () => {
      await Posts.proveMergedPostsTransitions(
        mergedTransitions,
        proof1,
        proof2
      );
    }).rejects.toThrowError(`Constraint unsatisfied (unreduced)`);
  });

  it(`updates the state of the 'EventsContract', when deleting a post`, async () => {
    await localDeploy();

    let currentPostsRoot = zkApp.posts.get();
    let currentPostsNumber = zkApp.postsNumber.get();
    const postsRoot = postsTree.getRoot();
    expect(currentPostsRoot).toEqual(postsRoot);
    expect(currentPostsNumber).toEqual(Field(0));

    const valid1 = createPostsTransitionValidInputs(
      senderAccount,
      senderKey,
      Field(777),
      Field(1),
      Field(1)
    );

    const transition1 = PostsTransition.createPostsTransition(
      valid1.signature,
      senderAccount,
      valid1.hashedPost,
      valid1.initialPostsRoot,
      valid1.latestPostsRoot,
      valid1.postWitness,
      valid1.postState.postNumber.sub(1),
      valid1.postState
    );

    const proof1 = await Posts.provePostsTransition(
      transition1,
      valid1.signature,
      senderAccount,
      valid1.hashedPost,
      valid1.initialPostsRoot,
      valid1.latestPostsRoot,
      valid1.postWitness,
      valid1.postState.postNumber.sub(1),
      valid1.postState
    );

    const txn1 = await Mina.transaction(senderAccount, () => {
      zkApp.update(proof1);
    });

    await txn1.prove();
    await txn1.sign([senderKey]).send();

    currentPostsRoot = zkApp.posts.get();
    currentPostsNumber = zkApp.postsNumber.get();
    expect(currentPostsRoot).toEqual(valid1.latestPostsRoot);
    expect(currentPostsNumber).toEqual(Field(1));

    Local.setGlobalSlot(2);

    const valid2 = createPostDeletionTransitionValidInputs(
      senderAccount,
      senderKey,
      valid1.hashedPost,
      valid1.postState,
      Field(2)
    );

    const transition2 = PostsTransition.createPostDeletionTransition(
      valid2.signature,
      senderAccount,
      valid2.hashedPost,
      valid2.initialPostsRoot,
      valid2.latestPostsRoot,
      valid2.postWitness,
      Field(1),
      Field(2),
      valid2.postState
    );
    const proof2 = await Posts.provePostDeletionTransition(
      transition2,
      valid2.signature,
      senderAccount,
      valid2.hashedPost,
      valid2.initialPostsRoot,
      valid2.latestPostsRoot,
      valid2.postWitness,
      Field(1),
      Field(2),
      valid2.postState
    );

    const txn2 = await Mina.transaction(senderAccount, () => {
      zkApp.update(proof2);
    });

    await txn2.prove();
    await txn2.sign([senderKey]).send();

    currentPostsRoot = zkApp.posts.get();
    currentPostsNumber = zkApp.postsNumber.get();
    expect(currentPostsRoot).toEqual(valid2.latestPostsRoot);
    expect(valid1.latestPostsRoot).not.toEqual(valid2.latestPostsRoot);
    expect(currentPostsNumber).toEqual(Field(1));
  });

  test(`if 'transition' and 'computedTransition' mismatch,\
  'Posts.provePostDeletionTransition()' throws 'Constraint unsatisfied' error`, async () => {
    await localDeploy();

    const valid1 = createPostsTransitionValidInputs(
      senderAccount,
      senderKey,
      Field(777),
      Field(1),
      Field(1)
    );

    const transition1 = PostsTransition.createPostsTransition(
      valid1.signature,
      senderAccount,
      valid1.hashedPost,
      valid1.initialPostsRoot,
      valid1.latestPostsRoot,
      valid1.postWitness,
      valid1.postState.postNumber.sub(1),
      valid1.postState
    );

    const proof1 = await Posts.provePostsTransition(
      transition1,
      valid1.signature,
      senderAccount,
      valid1.hashedPost,
      valid1.initialPostsRoot,
      valid1.latestPostsRoot,
      valid1.postWitness,
      valid1.postState.postNumber.sub(1),
      valid1.postState
    );

    const txn1 = await Mina.transaction(senderAccount, () => {
      zkApp.update(proof1);
    });

    await txn1.prove();
    await txn1.sign([senderKey]).send();

    Local.setGlobalSlot(2);

    const valid2 = createPostDeletionTransitionValidInputs(
      senderAccount,
      senderKey,
      valid1.hashedPost,
      valid1.postState,
      Field(2)
    );

    const transition2 = new PostsTransition({
      initialPostsRoot: Field(111),
      latestPostsRoot: valid2.latestPostsRoot,
      initialPostsNumber: valid2.postState.postNumber,
      latestPostsNumber: valid2.postState.postNumber,
      blockHeight: valid2.postState.blockHeight,
    });

    await expect(async () => {
      const proof2 = await Posts.provePostDeletionTransition(
        transition2,
        valid2.signature,
        senderAccount,
        valid2.hashedPost,
        valid2.initialPostsRoot,
        valid2.latestPostsRoot,
        valid2.postWitness,
        Field(1),
        Field(2),
        valid2.postState
      );
    }).rejects.toThrowError(`Constraint unsatisfied (unreduced)`);
  });

  test(`if message to delete post is signed by a different account,\
  the signature is invalid in 'createPostDeletionTransition()'`, async () => {
    const valid1 = createPostsTransitionValidInputs(
      senderAccount,
      senderKey,
      Field(777),
      Field(1),
      Field(1)
    );
    const valid2 = createPostDeletionTransitionValidInputs(
      senderAccount,
      senderKey,
      valid1.hashedPost,
      valid1.postState,
      Field(1)
    );

    expect(() => {
      PostsTransition.createPostDeletionTransition(
        valid2.signature,
        PrivateKey.random().toPublicKey(),
        valid2.hashedPost,
        valid2.initialPostsRoot,
        valid2.latestPostsRoot,
        valid2.postWitness,
        Field(1),
        Field(1),
        valid2.postState
      );
    }).toThrowError(`Bool.assertTrue()`);
  });

  test(`if 'signature' is invalid for message to delete post,\
  'createPostDeletionTransition()' throws a 'Bool.assertTrue()' error`, async () => {
    const valid1 = createPostsTransitionValidInputs(
      senderAccount,
      senderKey,
      Field(777),
      Field(1),
      Field(1)
    );
    const valid2 = createPostDeletionTransitionValidInputs(
      senderAccount,
      senderKey,
      valid1.hashedPost,
      valid1.postState,
      Field(1)
    );

    expect(() => {
      PostsTransition.createPostDeletionTransition(
        valid2.signature,
        senderAccount,
        Field(111),
        valid2.initialPostsRoot,
        valid2.latestPostsRoot,
        valid2.postWitness,
        Field(1),
        Field(1),
        valid2.postState
      );
    }).toThrowError(`Bool.assertTrue()`);
  });

  test(`if 'initialPostsRoot' and the root derived from 'postWitness' mismatch,\
  'createPostDeletionTransition()' throws a 'Field.assertEquals()' error`, async () => {
    const valid1 = createPostsTransitionValidInputs(
      senderAccount,
      senderKey,
      Field(777),
      Field(1),
      Field(1)
    );
    const valid2 = createPostDeletionTransitionValidInputs(
      senderAccount,
      senderKey,
      valid1.hashedPost,
      valid1.postState,
      Field(1)
    );

    expect(() => {
      PostsTransition.createPostDeletionTransition(
        valid2.signature,
        senderAccount,
        valid2.hashedPost,
        Field(111),
        valid2.latestPostsRoot,
        valid2.postWitness,
        Field(1),
        Field(1),
        valid2.postState
      );
    }).toThrowError(`Field.assertEquals()`);
  });

  test(`if 'latestPostsRoot' and the updated root mismatch,\
  'createPostDeletionTransition()' throws a 'Field.assertEquals()' error`, async () => {
    const valid1 = createPostsTransitionValidInputs(
      senderAccount,
      senderKey,
      Field(777),
      Field(1),
      Field(1)
    );
    const valid2 = createPostDeletionTransitionValidInputs(
      senderAccount,
      senderKey,
      valid1.hashedPost,
      valid1.postState,
      Field(1)
    );

    expect(() => {
      PostsTransition.createPostDeletionTransition(
        valid2.signature,
        senderAccount,
        valid2.hashedPost,
        valid2.initialPostsRoot,
        Field(111),
        valid2.postWitness,
        Field(1),
        Field(1),
        valid2.postState
      );
    }).toThrowError(`Field.assertEquals()`);
  });

  test(`if the post doesn't exist, 'createPostDeletionTransition()'\
  throws a 'Field.assertEquals()' error`, async () => {
    const valid1 = createPostsTransitionValidInputs(
      senderAccount,
      senderKey,
      Field(777),
      Field(1),
      Field(1)
    );
    const valid2 = createPostDeletionTransitionValidInputs(
      senderAccount,
      senderKey,
      valid1.hashedPost,
      valid1.postState,
      Field(1)
    );

    const emptyTree = new MerkleMap();
    const emptyTreeRoot = emptyTree.getRoot();

    expect(() => {
      PostsTransition.createPostDeletionTransition(
        valid2.signature,
        senderAccount,
        valid2.hashedPost,
        emptyTreeRoot,
        valid2.latestPostsRoot,
        valid2.postWitness,
        Field(1),
        Field(1),
        valid2.postState
      );
    }).toThrowError(`Field.assertEquals()`);
  });

  it(`merges post deletion transitions`, async () => {
    await localDeploy();

    let currentPostsRoot = zkApp.posts.get();
    let currentPostsNumber = zkApp.postsNumber.get();
    const postsRoot = postsTree.getRoot();
    expect(currentPostsRoot).toEqual(postsRoot);
    expect(currentPostsNumber).toEqual(Field(0));

    const valid1 = createPostsTransitionValidInputs(
      senderAccount,
      senderKey,
      Field(777),
      Field(1),
      Field(1)
    );
    const transition1 = PostsTransition.createPostsTransition(
      valid1.signature,
      senderAccount,
      valid1.hashedPost,
      valid1.initialPostsRoot,
      valid1.latestPostsRoot,
      valid1.postWitness,
      valid1.postState.postNumber.sub(1),
      valid1.postState
    );
    const proof1 = await Posts.provePostsTransition(
      transition1,
      valid1.signature,
      senderAccount,
      valid1.hashedPost,
      valid1.initialPostsRoot,
      valid1.latestPostsRoot,
      valid1.postWitness,
      valid1.postState.postNumber.sub(1),
      valid1.postState
    );

    const valid2 = createPostsTransitionValidInputs(
      deployerAccount,
      deployerKey,
      Field(212),
      Field(2),
      Field(1)
    );
    const transition2 = PostsTransition.createPostsTransition(
      valid2.signature,
      deployerAccount,
      valid2.hashedPost,
      valid2.initialPostsRoot,
      valid2.latestPostsRoot,
      valid2.postWitness,
      valid2.postState.postNumber.sub(1),
      valid2.postState
    );
    const proof2 = await Posts.provePostsTransition(
      transition2,
      valid2.signature,
      deployerAccount,
      valid2.hashedPost,
      valid2.initialPostsRoot,
      valid2.latestPostsRoot,
      valid2.postWitness,
      valid2.postState.postNumber.sub(1),
      valid2.postState
    );

    const mergedTransitions1 = PostsTransition.mergePostsTransitions(
      transition1,
      transition2
    );

    const mergedTransitionsProof1 = await Posts.proveMergedPostsTransitions(
      mergedTransitions1,
      proof1,
      proof2
    );

    const txn1 = await Mina.transaction(senderAccount, () => {
      zkApp.update(mergedTransitionsProof1);
    });

    await txn1.prove();
    await txn1.sign([senderKey]).send();

    currentPostsRoot = zkApp.posts.get();
    currentPostsNumber = zkApp.postsNumber.get();
    expect(currentPostsRoot).toEqual(valid2.latestPostsRoot);
    expect(currentPostsNumber).toEqual(Field(2));

    Local.setGlobalSlot(2);

    const valid3 = createPostDeletionTransitionValidInputs(
      senderAccount,
      senderKey,
      valid1.hashedPost,
      valid1.postState,
      Field(2)
    );

    const transition3 = PostsTransition.createPostDeletionTransition(
      valid3.signature,
      senderAccount,
      valid3.hashedPost,
      valid3.initialPostsRoot,
      valid3.latestPostsRoot,
      valid3.postWitness,
      Field(2),
      Field(2),
      valid3.postState
    );
    const proof3 = await Posts.provePostDeletionTransition(
      transition3,
      valid3.signature,
      senderAccount,
      valid3.hashedPost,
      valid3.initialPostsRoot,
      valid3.latestPostsRoot,
      valid3.postWitness,
      Field(2),
      Field(2),
      valid3.postState
    );

    const valid4 = createPostDeletionTransitionValidInputs(
      deployerAccount,
      deployerKey,
      valid2.hashedPost,
      valid2.postState,
      Field(2)
    );

    const transition4 = PostsTransition.createPostDeletionTransition(
      valid4.signature,
      deployerAccount,
      valid4.hashedPost,
      valid4.initialPostsRoot,
      valid4.latestPostsRoot,
      valid4.postWitness,
      Field(2),
      Field(2),
      valid4.postState
    );
    const proof4 = await Posts.provePostDeletionTransition(
      transition4,
      valid4.signature,
      deployerAccount,
      valid4.hashedPost,
      valid4.initialPostsRoot,
      valid4.latestPostsRoot,
      valid4.postWitness,
      Field(2),
      Field(2),
      valid4.postState
    );

    const mergedTransitions2 = PostsTransition.mergePostsTransitions(
      transition3,
      transition4
    );

    const mergedTransitionsProof2 = await Posts.proveMergedPostsDeletions(
      mergedTransitions2,
      proof3,
      proof4
    );

    const txn2 = await Mina.transaction(senderAccount, () => {
      zkApp.update(mergedTransitionsProof2);
    });

    await txn2.prove();
    await txn2.sign([senderKey]).send();

    currentPostsRoot = zkApp.posts.get();
    currentPostsNumber = zkApp.postsNumber.get();
    expect(currentPostsRoot).toEqual(valid4.latestPostsRoot);
    expect(valid1.latestPostsRoot).not.toEqual(valid2.latestPostsRoot);
    expect(valid2.latestPostsRoot).not.toEqual(valid3.latestPostsRoot);
    expect(valid3.latestPostsRoot).not.toEqual(valid4.latestPostsRoot);
    expect(currentPostsNumber).toEqual(Field(2));
  });
});
