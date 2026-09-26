// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MirrorToken
/// @notice ERC-20 mirror of a token that lives on Solana. Every unit in
///         circulation is backed 1:1 by the real token held in the Solana
///         vault, so the mirror's price (and market cap) tracks the original.
/// @dev    Decimals match the source mint so raw amounts map 1:1 across chains.
///         Only the gateway that deployed it can mint or burn.
contract MirrorToken is ERC20 {
    address public immutable gateway;
    uint8 private immutable _decimals;

    /// @notice Chain the original token lives on (e.g. "solana").
    string public sourceChain;
    /// @notice Address / mint of the original token on the source chain.
    string public sourceToken;
    /// @notice Icon of the original token, copied at launch.
    string public logoURI;

    error OnlyGateway();

    event LogoUpdated(string logoURI);

    modifier onlyGateway() {
        if (msg.sender != gateway) revert OnlyGateway();
        _;
    }

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        string memory sourceChain_,
        string memory sourceToken_,
        string memory logoURI_
    ) ERC20(name_, symbol_) {
        gateway = msg.sender;
        _decimals = decimals_;
        sourceChain = sourceChain_;
        sourceToken = sourceToken_;
        logoURI = logoURI_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external onlyGateway {
        _mint(to, amount);
    }

    function burn(uint256 amount) external onlyGateway {
        _burn(msg.sender, amount);
    }

    function setLogoURI(string calldata logoURI_) external onlyGateway {
        logoURI = logoURI_;
        emit LogoUpdated(logoURI_);
    }
}
