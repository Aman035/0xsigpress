"""sigpress replacement for the unpublished `terminal_hashes` module imported by
sol-whir-p3's `leanvm_terminal_fixture_codec.py`.

Written from scratch: a plain Keccak-256 (Ethereum padding 0x01, not SHA3's 0x06) and the inverse of
leanVM's `encode_keccak240` (crates/backend/symetric/src/keccak.rs): eight 30-bit KoalaBear limbs ->
two 15-byte big-endian halves -> 32-byte digest whose last two bytes are zero.
"""

_RC = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]
_ROT = [
    [0, 36, 3, 41, 18],
    [1, 44, 10, 45, 2],
    [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56],
    [27, 20, 39, 8, 14],
]
_MASK = (1 << 64) - 1


def _rol(value, shift):
    shift %= 64
    return ((value << shift) | (value >> (64 - shift))) & _MASK


def _keccak_f(a):
    for rc in _RC:
        c = [a[x][0] ^ a[x][1] ^ a[x][2] ^ a[x][3] ^ a[x][4] for x in range(5)]
        d = [c[(x - 1) % 5] ^ _rol(c[(x + 1) % 5], 1) for x in range(5)]
        a = [[a[x][y] ^ d[x] for y in range(5)] for x in range(5)]
        b = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                b[y][(2 * x + 3 * y) % 5] = _rol(a[x][y], _ROT[x][y])
        a = [[b[x][y] ^ ((~b[(x + 1) % 5][y]) & b[(x + 2) % 5][y]) for y in range(5)] for x in range(5)]
        a[0][0] ^= rc
    return a


def keccak256(data):
    rate = 136
    data = bytes(data)
    padded = bytearray(data) + b"\x01" + b"\x00" * ((-len(data) - 2) % rate) + b"\x80"
    if len(padded) % rate:
        raise AssertionError("padding")
    state = [[0] * 5 for _ in range(5)]
    for offset in range(0, len(padded), rate):
        block = padded[offset:offset + rate]
        for i in range(rate // 8):
            x, y = i % 5, i // 5
            state[x][y] ^= int.from_bytes(block[8 * i:8 * i + 8], "little")
        state = _keccak_f(state)
    out = b"".join(state[i % 5][i // 5].to_bytes(8, "little") for i in range(4))
    return out


def limbs_digest(limbs):
    """Decode eight keccak240 limbs into the 32-byte digest (bytes 30..32 are zero)."""
    limbs = [int(value) for value in limbs]
    if len(limbs) != 8 or any(value >= 1 << 30 for value in limbs):
        raise ValueError("invalid keccak240 limbs")
    digest = bytearray(32)
    for half in range(2):
        packed = 0
        for value in limbs[4 * half:4 * half + 4]:
            packed = (packed << 30) | value
        digest[15 * half:15 * half + 15] = packed.to_bytes(16, "big")[1:]
    return bytes(digest)
