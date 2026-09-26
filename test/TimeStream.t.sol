// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {TimeStream} from "../src/TimeStream.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract TimeStreamTest is Test {
    TimeStream internal ts;
    MockERC20 internal token;

    address internal client = makeAddr("client");
    address internal freelancer = makeAddr("freelancer");
    address internal outsider = makeAddr("outsider");

    uint256 internal constant TOTAL = 1_000e6; // 1000 USDC (6 decimals)
    uint256 internal constant DURATION = 1_000; // seconds
    uint256 internal constant INTERVAL = 100; // seconds between check-ins

    function setUp() public {
        ts = new TimeStream();
        token = new MockERC20();

        token.mint(client, 10_000e6);

        vm.startPrank(client);
        token.approve(address(ts), type(uint256).max);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    function _create() internal returns (uint256 id) {
        vm.prank(client);
        id = ts.createStream(freelancer, address(token), TOTAL, DURATION, INTERVAL);
    }

    function _createAndAccept() internal returns (uint256 id) {
        id = _create();
        vm.prank(freelancer);
        ts.acceptStream(id);
    }

    // ------------------------------------------------------------------
    // 1. createStream
    // ------------------------------------------------------------------

    function test_CreateStreamEscrowsFundsAndInitialises() public {
        uint256 id = _create();

        (
            address c,
            address f,
            address t,
            uint256 totalAmount,
            uint256 startTime,
            uint256 endTime,
            uint256 withdrawn,
            bool active,
            bool accepted,
            uint256 lastCheckIn,
            uint256 checkInInterval
        ) = ts.getStream(id);

        assertEq(c, client, "client");
        assertEq(f, freelancer, "freelancer");
        assertEq(t, address(token), "token");
        assertEq(totalAmount, TOTAL, "totalAmount");
        assertEq(startTime, 0, "startTime must be unset until accept");
        assertEq(endTime, 0, "endTime must be unset until accept");
        assertEq(withdrawn, 0, "withdrawn");
        assertTrue(active, "active on create");
        assertFalse(accepted, "accepted must be false on create");
        assertEq(lastCheckIn, 0, "lastCheckIn");
        assertEq(checkInInterval, INTERVAL, "checkInInterval");

        assertEq(token.balanceOf(address(ts)), TOTAL, "escrowed");
        assertEq(token.balanceOf(client), 10_000e6 - TOTAL, "client debited");
        assertEq(ts.earnedAmount(id), 0, "no earnings before accept");
    }

    function test_CreateStreamValidation() public {
        vm.startPrank(client);

        vm.expectRevert(TimeStream.ZeroAddress.selector);
        ts.createStream(address(0), address(token), TOTAL, DURATION, INTERVAL);

        vm.expectRevert(TimeStream.ZeroAddress.selector);
        ts.createStream(freelancer, address(0), TOTAL, DURATION, INTERVAL);

        vm.expectRevert(TimeStream.ZeroAmount.selector);
        ts.createStream(freelancer, address(token), 0, DURATION, INTERVAL);

        vm.expectRevert(TimeStream.ZeroDuration.selector);
        ts.createStream(freelancer, address(token), TOTAL, 0, INTERVAL);

        vm.expectRevert(TimeStream.ZeroCheckInInterval.selector);
        ts.createStream(freelancer, address(token), TOTAL, DURATION, 0);

        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // 2. acceptStream
    // ------------------------------------------------------------------

    function test_AcceptStreamStartsTheClock() public {
        uint256 id = _create();
        uint256 acceptedAt = block.timestamp;

        vm.prank(freelancer);
        ts.acceptStream(id);

        (,,,,,,, bool active, bool accepted, uint256 lastCheckIn,) = ts.getStream(id);
        assertTrue(accepted, "accepted");
        assertTrue(active, "still active");
        assertEq(lastCheckIn, acceptedAt, "lastCheckIn seeded to startTime");

        (uint256 startTime, uint256 endTime) = _times(id);
        assertEq(startTime, acceptedAt, "startTime");
        assertEq(endTime, acceptedAt + DURATION, "endTime");
    }

    function test_AcceptStream_Revert_NotFreelancer() public {
        uint256 id = _create();

        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(TimeStream.NotFreelancer.selector, id, client));
        ts.acceptStream(id);
    }

    function test_AcceptStream_Revert_AlreadyAccepted() public {
        uint256 id = _createAndAccept();

        vm.prank(freelancer);
        vm.expectRevert(abi.encodeWithSelector(TimeStream.StreamAlreadyAccepted.selector, id));
        ts.acceptStream(id);
    }

    // ------------------------------------------------------------------
    // 3. accrual over time
    // ------------------------------------------------------------------

    function test_EarningsAccrueWithCheckIns() public {
        uint256 id = _createAndAccept();
        uint256 t0 = block.timestamp;

        vm.warp(t0 + INTERVAL);
        vm.prank(freelancer);
        ts.checkIn(id);

        vm.warp(t0 + 2 * INTERVAL);

        // 200s of 1000s elapsed -> 200 USDC of 1000
        assertEq(ts.earnedAmount(id), 200e6, "accrued pro rata");
    }

    function test_CheckInRequired_AccrualCapsWithoutIt() public {
        uint256 id = _createAndAccept();
        uint256 t0 = block.timestamp;

        // Freelancer goes silent for 500s without a single check-in.
        vm.warp(t0 + 500);

        // Capped at lastCheckIn + INTERVAL = t0 + 100 -> 100 USDC, not 500 USDC.
        assertEq(ts.earnedAmount(id), 100e6, "capped at one interval past last check-in");
    }

    function test_CannotWithdrawBeforeAccept() public {
        uint256 id = _create();

        vm.prank(freelancer);
        vm.expectRevert(abi.encodeWithSelector(TimeStream.NothingToWithdraw.selector, id));
        ts.withdraw(id);
    }

    function test_CheckIn_Revert_NotAccepted() public {
        uint256 id = _create();

        vm.prank(freelancer);
        vm.expectRevert(abi.encodeWithSelector(TimeStream.StreamNotAccepted.selector, id));
        ts.checkIn(id);
    }

    // ------------------------------------------------------------------
    // 4. withdraw
    // ------------------------------------------------------------------

    function test_WithdrawTransfersAccruedAmount() public {
        uint256 id = _createAndAccept();
        uint256 t0 = block.timestamp;

        vm.warp(t0 + INTERVAL);
        vm.prank(freelancer);
        ts.checkIn(id);
        vm.warp(t0 + 2 * INTERVAL);

        uint256 expected = 200e6;
        assertEq(ts.earnedAmount(id), expected, "pre-withdraw earned");

        vm.prank(freelancer);
        uint256 got = ts.withdraw(id);

        assertEq(got, expected, "returned amount");
        assertEq(token.balanceOf(freelancer), expected, "freelancer paid");
        assertEq(token.balanceOf(address(ts)), TOTAL - expected, "escrow reduced");

        (,,,,,, uint256 withdrawn,,,,) = ts.getStream(id);
        assertEq(withdrawn, expected, "withdrawn tracked");

        // Nothing left to pull until more time passes.
        assertEq(ts.earnedAmount(id), 0, "earnedAmount is net of withdrawn");
    }

    function test_Withdraw_Revert_NotFreelancer() public {
        uint256 id = _createAndAccept();
        vm.warp(block.timestamp + 50);

        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(TimeStream.NotFreelancer.selector, id, outsider));
        ts.withdraw(id);
    }

    // ------------------------------------------------------------------
    // 5. stopStream
    // ------------------------------------------------------------------

    function test_StopStreamPaysFreelancerAndRefundsClient() public {
        uint256 id = _createAndAccept();
        uint256 t0 = block.timestamp;

        vm.warp(t0 + 250);
        vm.prank(freelancer);
        ts.checkIn(id);
        vm.warp(t0 + 300);

        uint256 earnedForFreelancer = 300e6;
        uint256 expectedRefund = TOTAL - earnedForFreelancer;
        uint256 clientBefore = token.balanceOf(client);

        vm.prank(client);
        uint256 refund = ts.stopStream(id);

        assertEq(refund, expectedRefund, "refund amount");
        assertEq(token.balanceOf(freelancer), earnedForFreelancer, "freelancer paid on stop");
        assertEq(token.balanceOf(client), clientBefore + expectedRefund, "client refunded");
        assertEq(token.balanceOf(address(ts)), 0, "escrow fully drained");

        (,,,,,, uint256 withdrawn, bool active,,,) = ts.getStream(id);
        assertFalse(active, "stream closed");
        assertEq(withdrawn, TOTAL, "marked fully settled");
        assertEq(ts.earnedAmount(id), 0, "nothing left to earn");
    }

    function test_StopStream_Revert_NotClient() public {
        uint256 id = _createAndAccept();

        vm.prank(freelancer);
        vm.expectRevert(abi.encodeWithSelector(TimeStream.NotClient.selector, id, freelancer));
        ts.stopStream(id);
    }

    function test_StopStream_Revert_AlreadyStopped() public {
        uint256 id = _createAndAccept();

        vm.prank(client);
        ts.stopStream(id);

        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(TimeStream.StreamNotActive.selector, id));
        ts.stopStream(id);
    }

    function test_StopStreamBeforeAcceptRefundsEverything() public {
        uint256 id = _create();
        uint256 clientBefore = token.balanceOf(client);

        vm.prank(client);
        uint256 refund = ts.stopStream(id);

        assertEq(refund, TOTAL, "full refund when never accepted");
        assertEq(token.balanceOf(freelancer), 0, "freelancer got nothing");
        assertEq(token.balanceOf(client), clientBefore + TOTAL, "client made whole");
    }

    // ------------------------------------------------------------------
    // 6. full-length stream pays out everything
    // ------------------------------------------------------------------

    function test_StreamPaysInFullWhenCheckedInToTheEnd() public {
        uint256 id = _createAndAccept();
        uint256 t0 = block.timestamp;

        // Keep checking in right up to the end so accrual is never capped.
        for (uint256 i = 1; i <= 10; i++) {
            vm.warp(t0 + (i * 100));
            vm.prank(freelancer);
            ts.checkIn(id);
        }

        assertEq(ts.earnedAmount(id), TOTAL, "fully earned at endTime");

        vm.prank(freelancer);
        ts.withdraw(id);

        assertEq(token.balanceOf(freelancer), TOTAL, "paid in full");
        assertEq(token.balanceOf(address(ts)), 0, "escrow empty");
    }

    // ------------------------------------------------------------------
    // 7. multi-stream isolation (escrow is pooled, accounting is not)
    // ------------------------------------------------------------------

    function test_StopStreamDoesNotTouchAnotherStreamsEscrow() public {
        uint256 idA = _createAndAccept();
        uint256 idB = _createAndAccept();

        uint256 t0 = block.timestamp;
        vm.warp(t0 + 200);
        vm.prank(freelancer);
        ts.checkIn(idA);
        vm.prank(freelancer);
        ts.checkIn(idB);

        assertEq(token.balanceOf(address(ts)), 2 * TOTAL, "both escrowed");

        // Stop only stream A; stream B must be untouched.
        vm.prank(client);
        uint256 refundA = ts.stopStream(idA);

        assertEq(refundA, TOTAL - 200e6, "A refunded its unearned part");
        assertEq(token.balanceOf(address(ts)), TOTAL, "B's escrow intact");

        (uint256 startTimeB, uint256 endTimeB) = _times(idB);
        assertEq(startTimeB, t0, "B startTime unchanged");
        assertEq(endTimeB, t0 + DURATION, "B endTime unchanged");
        assertEq(ts.earnedAmount(idB), 200e6, "B still earning normally");
    }

    // ------------------------------------------------------------------
    // helpers returning partial tuples
    // ------------------------------------------------------------------

    function _times(uint256 id) internal view returns (uint256 startTime, uint256 endTime) {
        (,,,, uint256 s, uint256 e,,,,,) = ts.getStream(id);
        return (s, e);
    }
}
