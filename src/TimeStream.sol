// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title TimeStream
 * @notice Second-granular streaming payment escrow for freelance work.
 *
 * A client escrows `totalAmount` of an ERC-20 up front, the freelancer accepts
 * the job (which starts the clock), and payment accrues linearly with time.
 * The freelancer must `checkIn` at least once per `checkInInterval` seconds to
 * keep accruing; otherwise earnings are capped at `lastCheckIn + checkInInterval`.
 * That is what makes this a *streaming* payment rather than a plain vesting
 * schedule: a silent freelancer stops being paid.
 *
 * Accounting is fully per-stream. The contract holds the pooled balance of
 * every stream, so nothing here may read `token.balanceOf(address(this))` to
 * decide a payout - refunds are derived from the stream's own fields.
 *
 * @dev Reentrancy posture: OpenZeppelin 5.1's `ReentrancyGuard` relies on
 * EIP-1153 transient storage (TSTORE), which is not guaranteed on every Monad
 * EVM revision. This contract instead applies checks-effects-interactions
 * rigorously: every function that moves tokens writes its state *before* the
 * external call, and no external call result is used to make a state decision.
 */
contract TimeStream {
    using SafeERC20 for IERC20;

    struct Stream {
        address client;
        address freelancer;
        address token;
        uint256 totalAmount;
        uint256 startTime;
        uint256 endTime;
        uint256 withdrawn;
        bool active;
        bool accepted;
        uint256 lastCheckIn;
        uint256 checkInInterval;
    }

    /// @notice Auto-incrementing id of the next stream. The first stream is id 0.
    uint256 public nextStreamId;

    /// @dev Duration in seconds, kept out of `Stream` to preserve the exact
    ///      11-field layout. It is only needed at accept time, because
    ///      `endTime` cannot be derived before `startTime` exists.
    mapping(uint256 streamId => uint256 durationSeconds) public streamDuration;

    mapping(uint256 streamId => Stream) private _streams;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event StreamCreated(
        uint256 indexed streamId,
        address indexed client,
        address indexed freelancer,
        address token,
        uint256 totalAmount,
        uint256 durationSeconds,
        uint256 checkInIntervalSeconds
    );
    event StreamAccepted(uint256 indexed streamId, uint256 startTime, uint256 endTime);
    event CheckedIn(uint256 indexed streamId, uint256 lastCheckIn);
    event Withdrawn(uint256 indexed streamId, uint256 amount);
    event StreamStopped(uint256 indexed streamId, uint256 refundToClient);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error ZeroAddress();
    error ZeroAmount();
    error ZeroDuration();
    error ZeroCheckInInterval();
    error NotClient(uint256 streamId, address caller);
    error NotFreelancer(uint256 streamId, address caller);
    error StreamAlreadyAccepted(uint256 streamId);
    error StreamNotAccepted(uint256 streamId);
    error StreamNotActive(uint256 streamId);
    error NothingToWithdraw(uint256 streamId);

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier onlyFreelancer(uint256 streamId) {
        Stream storage s = _streams[streamId];
        if (s.freelancer != msg.sender) revert NotFreelancer(streamId, msg.sender);
        _;
    }

    modifier onlyClient(uint256 streamId) {
        Stream storage s = _streams[streamId];
        if (s.client != msg.sender) revert NotClient(streamId, msg.sender);
        _;
    }

    // ---------------------------------------------------------------------
    // External functions
    // ---------------------------------------------------------------------

    /**
     * @notice Escrow `totalAmount` of `token` and open a new stream.
     * @dev The caller must have approved this contract for at least
     *      `totalAmount` of `token` beforehand. `accepted` stays false, so no
     *      time-based accounting happens until the freelancer accepts.
     */
    function createStream(
        address freelancer,
        address token,
        uint256 totalAmount,
        uint256 durationSeconds,
        uint256 checkInIntervalSeconds
    ) external returns (uint256 streamId) {
        if (freelancer == address(0) || token == address(0)) revert ZeroAddress();
        if (totalAmount == 0) revert ZeroAmount();
        if (durationSeconds == 0) revert ZeroDuration();
        if (checkInIntervalSeconds == 0) revert ZeroCheckInInterval();

        streamId = nextStreamId++;
        streamDuration[streamId] = durationSeconds;

        Stream storage s = _streams[streamId];
        s.client = msg.sender;
        s.freelancer = freelancer;
        s.token = token;
        s.totalAmount = totalAmount;
        s.active = true;
        s.accepted = false;
        s.checkInInterval = checkInIntervalSeconds;
        // startTime / endTime / lastCheckIn stay 0 until acceptStream().

        // Interaction last: the stream row is already fully populated, and the
        // whole transaction reverts anyway if the transfer fails.
        IERC20(token).safeTransferFrom(msg.sender, address(this), totalAmount);

        emit StreamCreated(
            streamId, msg.sender, freelancer, token, totalAmount, durationSeconds, checkInIntervalSeconds
        );
    }

    /// @notice Freelancer accepts the job. Starts the clock.
    function acceptStream(uint256 streamId) external onlyFreelancer(streamId) {
        Stream storage s = _streams[streamId];
        if (s.accepted) revert StreamAlreadyAccepted(streamId);
        if (!s.active) revert StreamNotActive(streamId);

        uint256 startTime = block.timestamp;
        uint256 endTime = startTime + streamDuration[streamId];

        s.accepted = true;
        s.startTime = startTime;
        s.endTime = endTime;
        s.lastCheckIn = startTime;

        emit StreamAccepted(streamId, startTime, endTime);
    }

    /// @notice Freelancer confirms they are still working, un-capping accrual.
    function checkIn(uint256 streamId) external onlyFreelancer(streamId) {
        Stream storage s = _streams[streamId];
        if (!s.accepted) revert StreamNotAccepted(streamId);
        if (!s.active) revert StreamNotActive(streamId);

        s.lastCheckIn = block.timestamp;

        emit CheckedIn(streamId, block.timestamp);
    }

    /**
     * @notice Amount currently withdrawable by the freelancer.
     * @dev Accrual stops at the earliest of: now, `lastCheckIn + checkInInterval`,
     *      and `endTime`. Already-withdrawn principal is subtracted, so this is
     *      the withdrawable remainder rather than the lifetime total.
     */
    function earnedAmount(uint256 streamId) public view returns (uint256) {
        Stream storage s = _streams[streamId];

        if (!s.accepted) return 0;

        uint256 duration = streamDuration[streamId];
        if (duration == 0) return 0;

        // Saturating add so an absurdly large checkInInterval cannot overflow.
        uint256 checkInDeadline = s.lastCheckIn > type(uint256).max - s.checkInInterval
            ? type(uint256).max
            : s.lastCheckIn + s.checkInInterval;

        uint256 effectiveEnd = block.timestamp;
        if (checkInDeadline < effectiveEnd) effectiveEnd = checkInDeadline;
        if (s.endTime < effectiveEnd) effectiveEnd = s.endTime;

        uint256 elapsed = effectiveEnd > s.startTime ? effectiveEnd - s.startTime : 0;

        // mulDiv keeps full 512-bit precision, so large totals cannot overflow.
        uint256 earned = Math.mulDiv(s.totalAmount, elapsed, duration);
        if (earned <= s.withdrawn) return 0;
        return earned - s.withdrawn;
    }

    /// @notice Freelancer pulls whatever has accrued so far.
    function withdraw(uint256 streamId) external onlyFreelancer(streamId) returns (uint256 amount) {
        Stream storage s = _streams[streamId];

        amount = earnedAmount(streamId);
        if (amount == 0) revert NothingToWithdraw(streamId);

        // Effect before interaction.
        s.withdrawn += amount;

        IERC20(s.token).safeTransfer(s.freelancer, amount);

        emit Withdrawn(streamId, amount);
    }

    /**
     * @notice Client ends the stream early.
     * @dev Pays the freelancer everything accrued to now and refunds the rest,
     *      including any dust left by integer rounding of the accrual formula.
     */
    function stopStream(uint256 streamId) external onlyClient(streamId) returns (uint256 refundToClient) {
        Stream storage s = _streams[streamId];
        if (!s.active) revert StreamNotActive(streamId);

        uint256 amountFreelancer = earnedAmount(streamId);

        // Per-stream accounting, never the contract's pooled token balance.
        refundToClient = s.totalAmount - (s.withdrawn + amountFreelancer);

        // Effects: mark settled and closed before any transfer.
        s.active = false;
        s.withdrawn = s.totalAmount;

        if (amountFreelancer > 0) {
            IERC20(s.token).safeTransfer(s.freelancer, amountFreelancer);
            emit Withdrawn(streamId, amountFreelancer);
        }
        if (refundToClient > 0) {
            IERC20(s.token).safeTransfer(s.client, refundToClient);
        }

        emit StreamStopped(streamId, refundToClient);
    }

    /// @notice Full stream record, fields in declaration order.
    function getStream(uint256 streamId)
        external
        view
        returns (
            address client,
            address freelancer,
            address token,
            uint256 totalAmount,
            uint256 startTime,
            uint256 endTime,
            uint256 withdrawn,
            bool active,
            bool accepted,
            uint256 lastCheckIn,
            uint256 checkInInterval
        )
    {
        Stream storage s = _streams[streamId];
        return (
            s.client,
            s.freelancer,
            s.token,
            s.totalAmount,
            s.startTime,
            s.endTime,
            s.withdrawn,
            s.active,
            s.accepted,
            s.lastCheckIn,
            s.checkInInterval
        );
    }

    /// @notice Number of streams ever created.
    function streamCount() external view returns (uint256) {
        return nextStreamId;
    }
}
