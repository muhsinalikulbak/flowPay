// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {TimeStream} from "../src/TimeStream.sol";

/**
 * @notice Deploys TimeStream to Monad testnet (chain id 10143).
 *
 * @dev SIGNING / KEY HANDLING
 *
 * This script deliberately does NOT read a private key from anywhere - not from
 * an env var, not from a file, not from a constructor argument. `vm.startBroadcast()`
 * is called with no arguments, so the signer is injected by forge from the account
 * unlocked on the command line:
 *
 *     cast wallet import <name> --interactive     # once, creates an encrypted keystore
 *     forge script script/DeployTimeStream.s.sol:DeployTimeStream \
 *         --rpc-url monad_testnet --account <name> --broadcast
 *
 * That keeps the private key inside an encrypted `~/.foundry/keystore/<name>`
 * file that only this machine can decrypt, and never in the repo or in the
 * environment. Do not "simplify" this by switching to `vm.startBroadcast(privateKey)`.
 */
contract DeployTimeStream is Script {
    uint256 internal constant MONAD_TESTNET_CHAIN_ID = 10143;

    /// @dev Circle USDC on Monad testnet, from monad-crypto/token-list
    ///      (tokenlist-testnet.json). Verified on-chain: decimals 6, symbol "USDC".
    address internal constant MONAD_TESTNET_USDC = 0x534b2f3A21130d7a60830c2Df862319e593943A3;

    function run() external returns (TimeStream deployed) {
        // Fail loudly rather than broadcasting to the wrong chain.
        uint256 chainId = block.chainid;
        require(chainId == MONAD_TESTNET_CHAIN_ID, "DeployTimeStream: not Monad testnet (10143)");

        // No argument => forge signs with the `--account` keystore.
        vm.startBroadcast();

        deployed = new TimeStream();

        vm.stopBroadcast();

        console.log("TimeStream deployed at:", address(deployed));
        console.log("chainId              :", chainId);
        console.log("deployer             :", msg.sender);
        console.log("Monad testnet USDC   :", MONAD_TESTNET_USDC);
    }
}
