// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice DreamDEX spot pool surface used for vault IOC round-trips.
interface ISpotPool {
    function deposit(address token, uint256 amount) external;

    function depositNative() external payable;

    function withdraw(address token, uint256 amount) external;

    function getWithdrawableBalance(address owner, address token) external view returns (uint256);

    function placeOrder(
        bool isBid,
        uint64 userData,
        uint256 price,
        uint256 quantity,
        uint64 expireTimestampNs,
        uint8 orderType,
        uint8 selfMatchingOption,
        address builder,
        uint96 builderFeeBpsTimes1k
    ) external payable returns (bool success, uint128 orderId);
}

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @title DreamDexVolumeBatch7702
/// @notice Implementation bytecode delegated onto an EOA via EIP-7702.
///         When invoked through delegation, address(this) is the funded wallet and
///         vault balances accrue to the EOA instead of a separate router contract.
contract DreamDexVolumeBatch7702 {
    uint8 internal constant ORDER_IOC = 2;
    uint8 internal constant SELF_MATCH_CANCEL_TAKER = 0;

    event RoundTripStarted(address indexed pool, uint256 quantity, uint256 buyPrice, uint256 sellPrice);
    event OrderPlaced(bool indexed isBid, bool success, uint128 orderId);
    event VaultSwept(address indexed token, uint256 amount);

    /// @notice Deposit quote, IOC buy, IOC sell, then sweep vault balances back to the EOA.
    /// @param quoteDeposit Quote pulled from the EOA wallet and deposited into the pool vault.
    /// @param buyPrice IOC bid price (typically best ask + cross bps).
    /// @param sellPrice IOC ask price (typically best bid - cross bps).
    /// @param quantity Base size for both legs (must meet pool min quantity / lot size).
    function atomicRoundTrip(
        address pool,
        address quoteToken,
        address baseToken,
        uint256 quoteDeposit,
        uint256 buyPrice,
        uint256 sellPrice,
        uint256 quantity,
        uint64 expireTimestampNs
    ) external payable {
        require(quantity > 0, "qty=0");
        require(buyPrice > 0 && sellPrice > 0, "price=0");
        require(quoteDeposit > 0, "quote=0");

        emit RoundTripStarted(pool, quantity, buyPrice, sellPrice);

        IERC20(quoteToken).approve(pool, quoteDeposit);
        ISpotPool(pool).deposit(quoteToken, quoteDeposit);

        _iocBuy(pool, buyPrice, quantity, expireTimestampNs);
        _iocSell(pool, sellPrice, quantity, expireTimestampNs);

        _sweep(pool, quoteToken);
        _sweep(pool, baseToken);
    }

    /// @notice STT-only path: sell deposited native for USDso, IOC buy, IOC sell, sweep.
    /// @dev Send `nativeSellAmount` as msg.value on the type-4 tx. Must be >= quantity and
    ///      large enough that sell proceeds cover the buy (checked off-chain in the script).
    /// @param nativeSellAmount Native base deposited and IOC-sold to fund the buy leg.
    function atomicRoundTripFromNative(
        address pool,
        address quoteToken,
        address baseToken,
        uint256 nativeSellAmount,
        uint256 buyPrice,
        uint256 sellPrice,
        uint256 quantity,
        uint64 expireTimestampNs
    ) external payable {
        require(msg.value >= nativeSellAmount, "native");
        require(nativeSellAmount >= quantity, "sell<qty");
        require(quantity > 0, "qty=0");
        require(buyPrice > 0 && sellPrice > 0, "price=0");

        emit RoundTripStarted(pool, quantity, buyPrice, sellPrice);

        ISpotPool(pool).depositNative{value: nativeSellAmount}();
        _iocSell(pool, sellPrice, nativeSellAmount, expireTimestampNs);
        _iocBuy(pool, buyPrice, quantity, expireTimestampNs);
        _iocSell(pool, sellPrice, quantity, expireTimestampNs);

        _sweep(pool, quoteToken);
        _sweep(pool, baseToken);
    }

    function _iocBuy(address pool, uint256 buyPrice, uint256 quantity, uint64 expireTimestampNs) private {
        (bool buyOk, uint128 buyId) = ISpotPool(pool).placeOrder(
            true,
            0,
            buyPrice,
            quantity,
            expireTimestampNs,
            ORDER_IOC,
            SELF_MATCH_CANCEL_TAKER,
            address(0),
            0
        );
        emit OrderPlaced(true, buyOk, buyId);
        require(buyOk, "buy failed");
    }

    function _iocSell(address pool, uint256 sellPrice, uint256 quantity, uint64 expireTimestampNs) private {
        (bool sellOk, uint128 sellId) = ISpotPool(pool).placeOrder(
            false,
            0,
            sellPrice,
            quantity,
            expireTimestampNs,
            ORDER_IOC,
            SELF_MATCH_CANCEL_TAKER,
            address(0),
            0
        );
        emit OrderPlaced(false, sellOk, sellId);
        require(sellOk, "sell failed");
    }

    function sweepVault(address pool, address quoteToken, address baseToken) external {
        _sweep(pool, quoteToken);
        _sweep(pool, baseToken);
    }

    function _sweep(address pool, address token) private {
        uint256 amount = ISpotPool(pool).getWithdrawableBalance(address(this), token);
        if (amount == 0) {
            return;
        }
        ISpotPool(pool).withdraw(token, amount);
        emit VaultSwept(token, amount);
    }
}
