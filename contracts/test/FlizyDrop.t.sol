// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FlizyDrop} from "../src/mint/FlizyDrop.sol";
import {FlizyCollection} from "../src/mint/FlizyCollection.sol";

/// A payout address that refuses ETH.
contract RejectingPayout {
    receive() external payable {
        revert("no");
    }

    function withdrawFrom(FlizyDrop drop) external {
        drop.withdraw();
    }
}

/// A payout address that tries to mint again from inside its receive().
contract ReentrantPayout {
    FlizyDrop internal drop;
    address internal collection;
    bool public reentryFailed;

    constructor(FlizyDrop drop_, address collection_) {
        drop = drop_;
        collection = collection_;
    }

    receive() external payable {
        try drop.mintPublic(collection, 1) {
            reentryFailed = false;
        } catch {
            reentryFailed = true;
        }
    }
}

/// An IFlizyMintable that re-enters the drop from mintTo.
contract ReentrantCollection {
    FlizyDrop internal drop;
    address public owner;
    uint256 public totalSupply;
    uint256 public maxSupply = 100;

    constructor(FlizyDrop drop_) {
        drop = drop_;
        owner = msg.sender;
    }

    function flizyMinter() external view returns (address) {
        return address(drop);
    }

    function mintTo(address, uint256 quantity) external returns (uint256) {
        drop.mintPublic(address(this), 1);
        totalSupply += quantity;
        return 1;
    }
}

/// An IFlizyMintable whose mintTo takes the call but mints nothing.
contract LyingCollection {
    address public flizyMinter;
    address public owner;
    uint256 public totalSupply;
    uint256 public maxSupply = 100;

    constructor(address drop_) {
        flizyMinter = drop_;
        owner = msg.sender;
    }

    function mintTo(address, uint256) external pure returns (uint256) {
        return 1;
    }
}

/// Answers flizyMinter() with the drop but has no owner().
contract OwnerlessCollection {
    address public flizyMinter;

    constructor(address drop_) {
        flizyMinter = drop_;
    }
}

contract FlizyDropTest is Test {
    FlizyDrop internal drop;
    FlizyCollection internal col;

    address internal flizy = makeAddr("flizy-owner");
    address internal feeTo = makeAddr("fee");
    address internal creator = makeAddr("creator");
    address internal payout = makeAddr("payout");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    uint64 internal constant T0 = 1_800_000_000;

    function setUp() public {
        vm.warp(T0);
        vm.prank(flizy);
        drop = new FlizyDrop(feeTo);
        col = new FlizyCollection("Franky", "FRANK", 50, "https://flizy.app/f.png", creator, address(drop), creator, 0);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
    }

    // --------------------------------------------------------------- helpers

    function _cfg(uint64 alStart, uint64 alEnd, uint64 pubStart, uint64 end, bytes32 root)
        internal
        view
        returns (FlizyDrop.Config memory)
    {
        return FlizyDrop.Config({
            allowlistStart: alStart,
            allowlistEnd: alEnd,
            publicStart: pubStart,
            mintEnd: end,
            allowlistPrice: 0.02 ether,
            publicPrice: 0.04 ether,
            publicLimit: 5,
            merkleRoot: root,
            payout: payout
        });
    }

    /// Allowlist 1h from T0+1h to T0+2h, public from T0+2h to T0+1d.
    function _standard(bytes32 root) internal view returns (FlizyDrop.Config memory) {
        return _cfg(T0 + 1 hours, T0 + 2 hours, T0 + 2 hours, T0 + 1 days, root);
    }

    function _configure(FlizyDrop.Config memory c) internal {
        vm.prank(creator);
        drop.configure(address(col), c);
    }

    function _leaf(address collection, address wallet, uint256 allowance) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(collection, wallet, allowance))));
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    /// Sorted copy; the caller's array keeps its order.
    function _sort(bytes32[] memory input) internal pure returns (bytes32[] memory xs) {
        xs = new bytes32[](input.length);
        for (uint256 i = 0; i < input.length; i++) xs[i] = input[i];
        for (uint256 i = 1; i < xs.length; i++) {
            bytes32 key = xs[i];
            uint256 j = i;
            while (j > 0 && xs[j - 1] > key) {
                xs[j] = xs[j - 1];
                j--;
            }
            xs[j] = key;
        }
    }

    /// Same algorithm as web/lib/mintMerkle.ts: sorted leaves, odd node carried up.
    function _root(bytes32[] memory leaves) internal pure returns (bytes32) {
        bytes32[] memory layer = _sort(leaves);
        while (layer.length > 1) {
            bytes32[] memory next = new bytes32[]((layer.length + 1) / 2);
            for (uint256 i = 0; i < layer.length; i += 2) {
                next[i / 2] = i + 1 < layer.length ? _hashPair(layer[i], layer[i + 1]) : layer[i];
            }
            layer = next;
        }
        return layer[0];
    }

    function _proof(bytes32[] memory leaves, bytes32 target) internal pure returns (bytes32[] memory proof) {
        bytes32[] memory layer = _sort(leaves);
        uint256 index = type(uint256).max;
        for (uint256 i = 0; i < layer.length; i++) {
            if (layer[i] == target) index = i;
        }
        require(index != type(uint256).max, "leaf not in list");
        bytes32[] memory buf = new bytes32[](32);
        uint256 n;
        while (layer.length > 1) {
            uint256 sibling = index % 2 == 0 ? index + 1 : index - 1;
            if (sibling < layer.length) buf[n++] = layer[sibling];
            bytes32[] memory next = new bytes32[]((layer.length + 1) / 2);
            for (uint256 i = 0; i < layer.length; i += 2) {
                next[i / 2] = i + 1 < layer.length ? _hashPair(layer[i], layer[i + 1]) : layer[i];
            }
            layer = next;
            index /= 2;
        }
        proof = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) proof[i] = buf[i];
    }

    /// alice 2, bob 1 on this collection.
    function _allowlist() internal view returns (bytes32[] memory leaves) {
        leaves = new bytes32[](2);
        leaves[0] = _leaf(address(col), alice, 2);
        leaves[1] = _leaf(address(col), bob, 1);
    }

    // ------------------------------------------------------- shared vector

    /// The same vector as test/mintMerkle.test.js. If this fails, the JS tree
    /// and the contract disagree and allowlist mints would be refused.
    function test_merkle_matches_js_vector() public pure {
        address c = address(0xC011);
        bytes32[] memory leaves = new bytes32[](3);
        leaves[0] = _leaf(c, address(0xa1), 1);
        leaves[1] = _leaf(c, address(0xa2), 2);
        leaves[2] = _leaf(c, address(0xa3), 3);
        bytes32 root = _root(leaves);
        assertEq(root, 0x0a67207a0fc53d2a411e10fa97b7840e08ce1c038fc78808e5d5230688272dde);
        bytes32[] memory p = _proof(leaves, leaves[1]);
        assertEq(p.length, 1);
        assertEq(p[0], 0xb17fb065cd243837bb254e555cfbf6d522fed8285a0ee7ae018ce6962cec456a);
        p = _proof(leaves, leaves[0]);
        assertEq(p.length, 2);
        assertEq(p[0], 0x2333ef30dd0d345105d9d9b5c25055a895ea0b2d02e5e8f9499600f4b590b181);
        assertEq(p[1], 0x80fa29b13dbf21561e7e320db99cbc6aa966304977cab7c686a1fdff724e7372);
    }

    // ----------------------------------------------------------- configure

    function test_constructor_rejects_zero_fee_recipient() public {
        vm.expectRevert(FlizyDrop.ZeroAddress.selector);
        new FlizyDrop(address(0));
    }

    function test_configure_stores_drop() public {
        _configure(_standard(bytes32(uint256(1))));
        (FlizyDrop.Config memory c, bool configured, bool paused_) = drop.getDrop(address(col));
        assertTrue(configured);
        assertFalse(paused_);
        assertEq(c.publicStart, T0 + 2 hours);
        assertEq(c.payout, payout);
        assertEq(c.merkleRoot, bytes32(uint256(1)));
    }

    function test_configure_only_collection_owner() public {
        FlizyDrop.Config memory c = _standard(bytes32(0));
        vm.expectRevert(FlizyDrop.NotCollectionOwner.selector);
        vm.prank(alice);
        drop.configure(address(col), c);
    }

    function test_configure_rejects_collection_without_this_minter() public {
        FlizyCollection other =
            new FlizyCollection("X", "X", 10, "https://flizy.app/x.png", creator, makeAddr("elsewhere"), creator, 0);
        FlizyDrop.Config memory c = _standard(bytes32(0));
        vm.expectRevert(FlizyDrop.NotFlizyMinter.selector);
        vm.prank(creator);
        drop.configure(address(other), c);

        vm.expectRevert(FlizyDrop.NotFlizyMinter.selector);
        vm.prank(creator);
        drop.configure(makeAddr("eoa"), c);

        // Giwaforge-style contract: no flizyMinter() at all.
        address plain = address(new RejectingPayout());
        vm.expectRevert(FlizyDrop.NotFlizyMinter.selector);
        vm.prank(creator);
        drop.configure(plain, c);
    }

    function test_configure_rejects_collection_without_owner() public {
        OwnerlessCollection x = new OwnerlessCollection(address(drop));
        FlizyDrop.Config memory c = _standard(bytes32(0));
        vm.expectRevert(FlizyDrop.NotCollectionOwner.selector);
        vm.prank(creator);
        drop.configure(address(x), c);
    }

    function test_configure_rejects_bad_schedules() public {
        vm.startPrank(creator);
        vm.expectRevert(FlizyDrop.BadSchedule.selector);
        drop.configure(address(col), _cfg(0, 0, 0, 0, 0)); // both phases off
        vm.expectRevert(FlizyDrop.BadSchedule.selector);
        drop.configure(address(col), _cfg(T0 + 10, T0 + 10, 0, 0, 0)); // empty allowlist window
        vm.expectRevert(FlizyDrop.BadSchedule.selector);
        drop.configure(address(col), _cfg(T0 + 10, T0 + 100, 0, T0 + 50, 0)); // allowlist past mint end
        vm.expectRevert(FlizyDrop.BadSchedule.selector);
        drop.configure(address(col), _cfg(0, 0, T0 + 100, T0 + 100, 0)); // public ends as it starts
        FlizyDrop.Config memory c = _cfg(0, 0, T0 + 100, 0, 0);
        c.publicLimit = 0;
        vm.expectRevert(FlizyDrop.BadLimit.selector);
        drop.configure(address(col), c);
        c = _cfg(0, 0, T0 + 100, 0, 0);
        c.payout = address(0);
        vm.expectRevert(FlizyDrop.ZeroAddress.selector);
        drop.configure(address(col), c);
        // Valid edge cases: public only with no end, allowlist only.
        drop.configure(address(col), _cfg(0, 0, T0 + 100, 0, 0));
        drop.configure(address(col), _cfg(T0 + 10, T0 + 100, 0, T0 + 100, 0));
        vm.stopPrank();
    }

    function test_setMerkleRoot_and_pause_need_owner_and_drop() public {
        vm.startPrank(creator);
        vm.expectRevert(FlizyDrop.NotConfigured.selector);
        drop.setMerkleRoot(address(col), bytes32(uint256(7)));
        vm.expectRevert(FlizyDrop.NotConfigured.selector);
        drop.setDropPaused(address(col), true);
        vm.stopPrank();

        _configure(_standard(bytes32(0)));
        vm.expectRevert(FlizyDrop.NotCollectionOwner.selector);
        vm.prank(alice);
        drop.setMerkleRoot(address(col), bytes32(uint256(7)));
        vm.expectRevert(FlizyDrop.NotCollectionOwner.selector);
        vm.prank(alice);
        drop.setDropPaused(address(col), true);

        vm.prank(creator);
        drop.setMerkleRoot(address(col), bytes32(uint256(7)));
        (FlizyDrop.Config memory c,,) = drop.getDrop(address(col));
        assertEq(c.merkleRoot, bytes32(uint256(7)));
        assertEq(c.publicPrice, 0.04 ether, "rest of the drop untouched");
    }

    function test_new_collection_owner_takes_over_the_drop() public {
        _configure(_standard(bytes32(0)));
        vm.prank(creator);
        col.transferOwnership(alice);
        vm.prank(alice);
        col.acceptOwnership();
        vm.expectRevert(FlizyDrop.NotCollectionOwner.selector);
        vm.prank(creator);
        drop.setDropPaused(address(col), true);
        vm.prank(alice);
        drop.setDropPaused(address(col), true);
    }

    // ---------------------------------------------------------- public mint

    function test_public_mint_pays_fee_and_creator() public {
        _configure(_standard(bytes32(0)));
        vm.warp(T0 + 2 hours);
        vm.prank(alice);
        uint256 first = drop.mintPublic{value: 0.12 ether}(address(col), 3);
        assertEq(first, 1);
        assertEq(col.balanceOf(alice), 3);
        assertEq(drop.publicMinted(address(col), alice), 3);
        assertEq(feeTo.balance, 0.0024 ether, "2% of 0.12");
        assertEq(payout.balance, 0.1176 ether);
        assertEq(address(drop).balance, 0);
    }

    function test_public_mint_window() public {
        _configure(_standard(bytes32(0)));
        vm.warp(T0 + 2 hours - 1);
        vm.expectRevert(FlizyDrop.NotLive.selector);
        vm.prank(alice);
        drop.mintPublic{value: 0.04 ether}(address(col), 1);

        vm.warp(T0 + 1 days);
        vm.expectRevert(FlizyDrop.NotLive.selector);
        vm.prank(alice);
        drop.mintPublic{value: 0.04 ether}(address(col), 1);
    }

    function test_public_mint_off_in_allowlist_only_drop() public {
        _configure(_cfg(T0 + 10, T0 + 100, 0, 0, bytes32(uint256(1))));
        vm.warp(T0 + 50);
        vm.expectRevert(FlizyDrop.NotLive.selector);
        vm.prank(alice);
        drop.mintPublic{value: 0.04 ether}(address(col), 1);
    }

    function test_public_mint_limits_quantity_and_payment() public {
        _configure(_standard(bytes32(0)));
        vm.warp(T0 + 2 hours);
        vm.startPrank(alice);
        vm.expectRevert(FlizyDrop.BadQuantity.selector);
        drop.mintPublic{value: 0}(address(col), 0);
        vm.expectRevert(FlizyDrop.BadQuantity.selector);
        drop.mintPublic{value: 0.84 ether}(address(col), 21);
        vm.expectRevert(FlizyDrop.WrongPayment.selector);
        drop.mintPublic{value: 0.03 ether}(address(col), 1);
        vm.expectRevert(FlizyDrop.WrongPayment.selector);
        drop.mintPublic{value: 0.05 ether}(address(col), 1);
        drop.mintPublic{value: 0.16 ether}(address(col), 4);
        vm.expectRevert(FlizyDrop.OverLimit.selector);
        drop.mintPublic{value: 0.08 ether}(address(col), 2);
        drop.mintPublic{value: 0.04 ether}(address(col), 1);
        vm.stopPrank();
        assertEq(drop.publicMinted(address(col), alice), 5);
    }

    function test_free_mint_takes_no_fee_and_no_eth() public {
        FlizyDrop.Config memory c = _standard(bytes32(0));
        c.publicPrice = 0;
        _configure(c);
        vm.warp(T0 + 2 hours);
        vm.expectRevert(FlizyDrop.WrongPayment.selector);
        vm.prank(alice);
        drop.mintPublic{value: 1}(address(col), 1);
        vm.prank(alice);
        drop.mintPublic(address(col), 2);
        assertEq(col.balanceOf(alice), 2);
        assertEq(feeTo.balance, 0);
        assertEq(payout.balance, 0);
    }

    function test_fee_rounds_down() public {
        FlizyDrop.Config memory c = _standard(bytes32(0));
        c.publicPrice = 99;
        _configure(c);
        vm.warp(T0 + 2 hours);
        vm.prank(alice);
        drop.mintPublic{value: 99}(address(col), 1);
        assertEq(feeTo.balance, 1); // 1.98 rounds down
        assertEq(payout.balance, 98);
    }

    function test_sold_out_bubbles_from_collection() public {
        FlizyCollection small =
            new FlizyCollection("S", "S", 3, "https://flizy.app/s.png", creator, address(drop), creator, 0);
        FlizyDrop.Config memory c = _standard(bytes32(0));
        c.publicLimit = 10;
        vm.prank(creator);
        drop.configure(address(small), c);
        vm.warp(T0 + 2 hours);
        vm.prank(alice);
        drop.mintPublic{value: 0.08 ether}(address(small), 2);
        vm.expectRevert(FlizyCollection.SoldOut.selector);
        vm.prank(bob);
        drop.mintPublic{value: 0.08 ether}(address(small), 2);
        assertEq(drop.publicMinted(address(small), bob), 0, "counter rolled back");
    }

    // -------------------------------------------------------- allowlist mint

    function test_allowlist_mint_with_valid_proof() public {
        bytes32[] memory leaves = _allowlist();
        _configure(_standard(_root(leaves)));
        vm.warp(T0 + 1 hours);
        bytes32[] memory proof = _proof(leaves, leaves[0]);
        vm.prank(alice);
        drop.mintAllowlist{value: 0.04 ether}(address(col), 2, 2, proof);
        assertEq(col.balanceOf(alice), 2);
        assertEq(drop.allowlistMinted(address(col), alice), 2);
        assertEq(feeTo.balance, 0.0008 ether);
        assertEq(payout.balance, 0.0392 ether);
    }

    function test_allowlist_allowance_spans_transactions() public {
        bytes32[] memory leaves = _allowlist();
        _configure(_standard(_root(leaves)));
        vm.warp(T0 + 1 hours);
        bytes32[] memory proof = _proof(leaves, leaves[0]);
        vm.startPrank(alice);
        drop.mintAllowlist{value: 0.02 ether}(address(col), 1, 2, proof);
        drop.mintAllowlist{value: 0.02 ether}(address(col), 1, 2, proof);
        vm.expectRevert(FlizyDrop.OverLimit.selector);
        drop.mintAllowlist{value: 0.02 ether}(address(col), 1, 2, proof);
        vm.stopPrank();
    }

    function test_allowlist_rejects_wrong_claims() public {
        bytes32[] memory leaves = _allowlist();
        _configure(_standard(_root(leaves)));
        vm.warp(T0 + 1 hours);
        bytes32[] memory aliceProof = _proof(leaves, leaves[0]);
        bytes32[] memory bobProof = _proof(leaves, leaves[1]);

        // Claiming a bigger allowance than listed.
        vm.expectRevert(FlizyDrop.NotOnAllowlist.selector);
        vm.prank(alice);
        drop.mintAllowlist{value: 0.06 ether}(address(col), 3, 3, aliceProof);

        // Someone else's proof.
        vm.expectRevert(FlizyDrop.NotOnAllowlist.selector);
        vm.prank(carol);
        drop.mintAllowlist{value: 0.02 ether}(address(col), 1, 1, bobProof);

        // A proof built for another collection.
        FlizyCollection other =
            new FlizyCollection("O", "O", 10, "https://flizy.app/o.png", creator, address(drop), creator, 0);
        bytes32[] memory otherLeaves = new bytes32[](2);
        otherLeaves[0] = _leaf(address(other), carol, 1);
        otherLeaves[1] = _leaf(address(other), bob, 1);
        bytes32[] memory carolOther = _proof(otherLeaves, otherLeaves[0]);
        vm.expectRevert(FlizyDrop.NotOnAllowlist.selector);
        vm.prank(carol);
        drop.mintAllowlist{value: 0.02 ether}(address(col), 1, 1, carolOther);
    }

    function test_allowlist_window_and_empty_root() public {
        bytes32[] memory leaves = _allowlist();
        bytes32[] memory proof = _proof(leaves, leaves[1]);
        _configure(_standard(_root(leaves)));

        vm.warp(T0 + 1 hours - 1);
        vm.expectRevert(FlizyDrop.NotLive.selector);
        vm.prank(bob);
        drop.mintAllowlist{value: 0.02 ether}(address(col), 1, 1, proof);

        vm.warp(T0 + 2 hours);
        vm.expectRevert(FlizyDrop.NotLive.selector);
        vm.prank(bob);
        drop.mintAllowlist{value: 0.02 ether}(address(col), 1, 1, proof);

        vm.prank(creator);
        drop.setMerkleRoot(address(col), bytes32(0));
        vm.warp(T0 + 1 hours);
        vm.expectRevert(FlizyDrop.NotOnAllowlist.selector);
        vm.prank(bob);
        drop.mintAllowlist{value: 0.02 ether}(address(col), 1, 1, proof);
    }

    function test_allowlist_off_in_public_only_drop() public {
        bytes32[] memory leaves = _allowlist();
        _configure(_cfg(0, 0, T0 + 10, 0, _root(leaves)));
        vm.warp(T0 + 20);
        bytes32[] memory proof = _proof(leaves, leaves[1]);
        vm.expectRevert(FlizyDrop.NotLive.selector);
        vm.prank(bob);
        drop.mintAllowlist{value: 0.02 ether}(address(col), 1, 1, proof);
    }

    function test_overlap_allows_both_and_counts_separately() public {
        bytes32[] memory leaves = _allowlist();
        // Public opens while the allowlist window is still running.
        _configure(_cfg(T0 + 10, T0 + 100, T0 + 50, 0, _root(leaves)));
        vm.warp(T0 + 60);
        bytes32[] memory proof = _proof(leaves, leaves[1]);
        vm.startPrank(bob);
        drop.mintAllowlist{value: 0.02 ether}(address(col), 1, 1, proof);
        drop.mintPublic{value: 0.2 ether}(address(col), 5);
        vm.stopPrank();
        assertEq(col.balanceOf(bob), 6);
        assertEq(drop.allowlistMinted(address(col), bob), 1);
        assertEq(drop.publicMinted(address(col), bob), 5);
    }

    function test_mint_end_closes_both_phases() public {
        bytes32[] memory leaves = _allowlist();
        _configure(_cfg(T0 + 10, T0 + 80, T0 + 50, T0 + 80, _root(leaves)));
        vm.warp(T0 + 80);
        bytes32[] memory proof = _proof(leaves, leaves[1]);
        vm.expectRevert(FlizyDrop.NotLive.selector);
        vm.prank(bob);
        drop.mintAllowlist{value: 0.02 ether}(address(col), 1, 1, proof);
        vm.expectRevert(FlizyDrop.NotLive.selector);
        vm.prank(bob);
        drop.mintPublic{value: 0.04 ether}(address(col), 1);
    }

    function test_unconfigured_drop_cannot_mint() public {
        bytes32[] memory proof = new bytes32[](0);
        vm.expectRevert(FlizyDrop.NotConfigured.selector);
        vm.prank(alice);
        drop.mintPublic{value: 0.04 ether}(address(col), 1);
        vm.expectRevert(FlizyDrop.NotConfigured.selector);
        vm.prank(alice);
        drop.mintAllowlist{value: 0.02 ether}(address(col), 1, 1, proof);
    }

    // --------------------------------------------------------------- pausing

    function test_global_and_drop_pause() public {
        _configure(_standard(bytes32(0)));
        vm.warp(T0 + 2 hours);

        vm.expectRevert(FlizyDrop.NotOwner.selector);
        vm.prank(alice);
        drop.setPaused(true);

        vm.prank(flizy);
        drop.setPaused(true);
        vm.expectRevert(FlizyDrop.Paused.selector);
        vm.prank(alice);
        drop.mintPublic{value: 0.04 ether}(address(col), 1);
        vm.prank(flizy);
        drop.setPaused(false);

        vm.prank(creator);
        drop.setDropPaused(address(col), true);
        vm.expectRevert(FlizyDrop.Paused.selector);
        vm.prank(alice);
        drop.mintPublic{value: 0.04 ether}(address(col), 1);
        vm.prank(creator);
        drop.setDropPaused(address(col), false);

        vm.prank(alice);
        drop.mintPublic{value: 0.04 ether}(address(col), 1);
    }

    // -------------------------------------------------------------- payments

    function test_rejecting_payout_is_credited_and_withdraws() public {
        RejectingPayout bad = new RejectingPayout();
        FlizyDrop.Config memory c = _standard(bytes32(0));
        c.payout = address(bad);
        _configure(c);
        vm.warp(T0 + 2 hours);
        vm.prank(alice);
        drop.mintPublic{value: 0.04 ether}(address(col), 1);
        assertEq(col.balanceOf(alice), 1, "the mint is not blocked");
        assertEq(drop.credits(address(bad)), 0.0392 ether);

        // It cannot take ETH at all, so its withdraw fails loudly and keeps the credit.
        vm.expectRevert(FlizyDrop.TransferFailed.selector);
        bad.withdrawFrom(drop);
        assertEq(drop.credits(address(bad)), 0.0392 ether);
    }

    function test_withdraw_pays_credit_even_when_paused() public {
        RejectingPayout bad = new RejectingPayout();
        FlizyDrop.Config memory c = _standard(bytes32(0));
        c.payout = address(bad);
        _configure(c);
        vm.warp(T0 + 2 hours);
        vm.prank(alice);
        drop.mintPublic{value: 0.04 ether}(address(col), 1);

        // Move the credit to an address that can take ETH, via a fresh deferral.
        vm.prank(flizy);
        drop.setPaused(true);
        vm.expectRevert(FlizyDrop.NothingToWithdraw.selector);
        vm.prank(alice);
        drop.withdraw();

        // Fee recipient that rejects, then withdraws once it can receive.
        vm.prank(flizy);
        drop.setPaused(false);
        address feeSink = address(new RejectingPayout());
        vm.prank(flizy);
        drop.setFeeRecipient(feeSink);
        vm.prank(bob);
        drop.mintPublic{value: 0.04 ether}(address(col), 1);
        assertEq(drop.credits(feeSink), 0.0008 ether);
        vm.etch(feeSink, hex"00");
        vm.prank(flizy);
        drop.setPaused(true);
        uint256 before = feeSink.balance;
        vm.prank(feeSink);
        drop.withdraw();
        assertEq(feeSink.balance - before, 0.0008 ether);
        assertEq(drop.credits(feeSink), 0);
    }

    function test_reentrant_payout_cannot_mint_again() public {
        ReentrantPayout r = new ReentrantPayout(drop, address(col));
        FlizyDrop.Config memory c = _standard(bytes32(0));
        c.payout = address(r);
        _configure(c);
        vm.warp(T0 + 2 hours);
        vm.prank(alice);
        drop.mintPublic{value: 0.04 ether}(address(col), 1);
        assertEq(col.totalSupply(), 1, "no second mint");
        assertTrue(r.reentryFailed(), "the nested mint was refused");
        assertEq(address(r).balance, 0.0392 ether, "the payout itself still arrived");
    }

    function test_reentrant_collection_reverts_whole_mint() public {
        vm.prank(creator);
        ReentrantCollection rc = new ReentrantCollection(drop);
        FlizyDrop.Config memory c = _standard(bytes32(0));
        c.publicPrice = 0;
        vm.prank(creator);
        drop.configure(address(rc), c);
        vm.warp(T0 + 2 hours);
        vm.expectRevert(FlizyDrop.Reentrancy.selector);
        vm.prank(alice);
        drop.mintPublic(address(rc), 1);
    }

    function test_collection_that_mints_nothing_is_refused() public {
        vm.prank(creator);
        LyingCollection liar = new LyingCollection(address(drop));
        vm.prank(creator);
        drop.configure(address(liar), _standard(bytes32(0)));
        vm.warp(T0 + 2 hours);
        vm.expectRevert(FlizyDrop.MintFailed.selector);
        vm.prank(alice);
        drop.mintPublic{value: 0.04 ether}(address(liar), 1);
        assertEq(alice.balance, 100 ether, "payment returned with the revert");
    }

    // ----------------------------------------------------------------- admin

    function test_fee_recipient_and_ownership() public {
        vm.expectRevert(FlizyDrop.NotOwner.selector);
        vm.prank(alice);
        drop.setFeeRecipient(alice);
        vm.expectRevert(FlizyDrop.ZeroAddress.selector);
        vm.prank(flizy);
        drop.setFeeRecipient(address(0));
        vm.prank(flizy);
        drop.setFeeRecipient(alice);
        assertEq(drop.feeRecipient(), alice);

        vm.expectRevert(FlizyDrop.NotOwner.selector);
        vm.prank(alice);
        drop.transferOwnership(alice);
        vm.prank(flizy);
        drop.transferOwnership(bob);
        vm.expectRevert(FlizyDrop.NotOwner.selector);
        vm.prank(alice);
        drop.acceptOwnership();
        vm.prank(bob);
        drop.acceptOwnership();
        assertEq(drop.owner(), bob);
        assertEq(drop.pendingOwner(), address(0));
    }
}
