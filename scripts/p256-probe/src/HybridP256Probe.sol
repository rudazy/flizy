// SPDX-License-Identifier: MIT AND Apache-2.0
pragma solidity 0.8.23;

/**
 * Probe of HybridDeleGator v1.3.0 P-256 / WebAuthn verification.
 * Logic copied from tag v1.3.0:
 *   HybridDeleGator._isValidSignature (P256 branch)
 *   P256VerifierLib._verifyWebAuthnP256Signature
 *   WebAuthn.verifySignature
 *   P256SCLVerifierLib.verifySignature
 * SCL_RIP7212 Solidity fallback is NOT included. If 0x100 fails this
 * probe returns false instead of running SCL.
 */
contract HybridP256Probe {
    address constant VERIFIER = address(0x100);
    uint256 constant P256_N_DIV_2 = 0x7fffffff800000007fffffffffffffffde73d556d38bcf4279dce5617e3192a8;
    bytes1 constant AUTH_DATA_FLAGS_UP = 0x01;
    bytes1 constant AUTH_DATA_FLAGS_UV = 0x04;
    bytes1 constant AUTH_DATA_FLAGS_BE = 0x08;
    bytes1 constant AUTH_DATA_FLAGS_BS = 0x10;

    function verifySignature(bytes32 messageHash, uint256 r, uint256 s, uint256 x, uint256 y) public view returns (bool) {
        if (s > P256_N_DIV_2) {
            return false;
        }
        bytes memory args = abi.encode(messageHash, r, s, x, y);
        (bool success, bytes memory ret) = VERIFIER.staticcall(args);
        bool valid = ret.length > 0;
        if (success && valid) return abi.decode(ret, (uint256)) == 1;
        return false;
    }

    function verifyWebAuthn(
        bytes memory challenge,
        bytes memory authenticatorData,
        bool requireUserVerification,
        string memory clientDataJSONPrefix,
        string memory clientDataJSONSuffix,
        uint256 responseTypeLocation,
        uint256 r,
        uint256 s,
        uint256 x,
        uint256 y
    )
        public
        view
        returns (bool)
    {
        if (authenticatorData.length < 37 || !checkAuthFlags(authenticatorData[32], requireUserVerification)) {
            return false;
        }
        bytes memory clientDataJSON =
            abi.encodePacked(clientDataJSONPrefix, encodeBase64Url(challenge), clientDataJSONSuffix);
        string memory responseType = '"type":"webauthn.get"';
        if (!contains(responseType, string(clientDataJSON), responseTypeLocation)) {
            return false;
        }
        bytes32 clientDataJSONHash = sha256(bytes(clientDataJSON));
        bytes32 messageHash = sha256(abi.encodePacked(authenticatorData, clientDataJSONHash));
        return verifySignature(messageHash, r, s, x, y);
    }

    function hybridWebAuthnBranch(bytes32 hash, bytes calldata signature, uint256 x, uint256 y) external view returns (bool) {
        if (signature.length < 96 || signature.length == 96) {
            return false;
        }
        (
            ,
            uint256 r,
            uint256 s,
            bytes memory authenticatorData,
            bool requireUserVerification,
            string memory clientDataJSONPrefix,
            string memory clientDataJSONSuffix,
            uint256 responseTypeLocation
        ) = abi.decode(signature, (bytes32, uint256, uint256, bytes, bool, string, string, uint256));
        return verifyWebAuthn(
            abi.encodePacked(hash),
            authenticatorData,
            requireUserVerification,
            clientDataJSONPrefix,
            clientDataJSONSuffix,
            responseTypeLocation,
            r,
            s,
            x,
            y
        );
    }

    function checkAuthFlags(bytes1 flags, bool requireUserVerification) internal pure returns (bool) {
        if (flags & AUTH_DATA_FLAGS_UP != AUTH_DATA_FLAGS_UP) return false;
        if (requireUserVerification && (flags & AUTH_DATA_FLAGS_UV) != AUTH_DATA_FLAGS_UV) return false;
        if (flags & AUTH_DATA_FLAGS_BE != AUTH_DATA_FLAGS_BE) {
            if (flags & AUTH_DATA_FLAGS_BS == AUTH_DATA_FLAGS_BS) return false;
        }
        return true;
    }

    function contains(string memory substr, string memory str, uint256 location) internal pure returns (bool) {
        bytes memory substrBytes = bytes(substr);
        bytes memory strBytes = bytes(str);
        uint256 substrLen = substrBytes.length;
        uint256 strLen = strBytes.length;
        for (uint256 i = 0; i < substrLen; i++) {
            if (location + i >= strLen) return false;
            if (substrBytes[i] != strBytes[location + i]) return false;
        }
        return true;
    }

    function encodeBase64Url(bytes memory data) internal pure returns (string memory) {
        string memory table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        uint256 len = data.length;
        if (len == 0) return "";
        uint256 encodedLen = 4 * ((len + 2) / 3);
        bytes memory result = new bytes(encodedLen);
        bytes memory tableBytes = bytes(table);
        uint256 i;
        uint256 j;
        while (i < len) {
            uint256 a = uint8(data[i]);
            uint256 b = i + 1 < len ? uint8(data[i + 1]) : 0;
            uint256 c = i + 2 < len ? uint8(data[i + 2]) : 0;
            result[j] = tableBytes[a >> 2];
            result[j + 1] = tableBytes[((a & 3) << 4) | (b >> 4)];
            result[j + 2] = tableBytes[((b & 15) << 2) | (c >> 6)];
            result[j + 3] = tableBytes[c & 63];
            i += 3;
            j += 4;
        }
        uint256 pad = (3 - (len % 3)) % 3;
        bytes memory trimmed = new bytes(encodedLen - pad);
        for (uint256 k = 0; k < trimmed.length; k++) {
            trimmed[k] = result[k];
        }
        return string(trimmed);
    }
}
