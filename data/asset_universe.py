"""The 750-asset universe for the market browser.

Lists below are deduped on import (preserving order). Stocks/ETFs use
exchange tickers consumable by yfinance; cryptos use CoinGecko coin IDs.
"""
from __future__ import annotations

# ---------- Stocks ----------
_STOCKS_RAW = [
    # USA mega cap
    "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "BRK-B", "AVGO", "JPM",
    "LLY", "V", "UNH", "XOM", "MA", "JNJ", "PG", "HD", "COST", "MRK",
    "ABBV", "BAC", "CRM", "CVX", "NFLX", "AMD", "KO", "PEP", "TMO", "WMT",
    "DIS", "CSCO", "MCD", "ADBE", "ABT", "NKE", "ACN", "ORCL", "DHR", "LIN",
    "TXN", "INTC", "QCOM", "UPS", "PM", "NEE", "HON", "BMY", "AMGN", "RTX",
    # USA mid cap
    "SBUX", "MS", "BLK", "SPGI", "GS", "AXP", "T", "VZ", "C", "USB",
    "MMC", "ISRG", "PLD", "CB", "SYK", "ZTS", "MO", "MDLZ", "CI", "TGT",
    "EOG", "HCA", "PGR", "FCX", "OXY", "GM", "F", "ATVI", "RIVN", "PLTR",
    "SNOW", "UBER", "LYFT", "ABNB", "DASH", "RBLX", "COIN", "SQ", "PYPL", "SHOP",
    # Europe
    "ASML", "SAP", "NESN.SW", "ROG.SW", "NOVN.SW", "MC.PA", "TTE.PA", "AIR.PA",
    "SIE.DE", "ADS.DE", "BMW.DE", "DTE.DE", "BAS.DE", "MBG.DE", "ALV.DE",
    "ULVR.L", "AZN.L", "HSBA.L", "BP.L", "GSK.L", "RIO.L", "AAL.L", "BARC.L",
    "SAN.MC", "IBE.MC", "ITX.MC",
    # Asia
    "TSM", "9988.HK", "0700.HK", "9618.HK", "BABA", "PDD", "NIO", "XPEV", "LI",
    "7203.T", "6758.T", "9432.T", "6861.T", "005930.KS", "000660.KS",
    "RELIANCE.NS", "TCS.NS", "INFY.NS", "HDFCBANK.NS", "ICICIBANK.NS",
    # Canada / Australia / Brazil
    "SHOP.TO", "TD.TO", "RY.TO", "CNQ.TO", "BHP.AX", "CBA.AX", "CSL.AX",
    "VALE", "ITUB", "PBR", "BBD", "ABEV",
    # Real estate REITs
    "O", "AMT", "EQIX", "SPG", "CCI", "PSA", "WELL", "AVB", "EQR",
    "VTR", "DLR", "IRM", "WPC", "NNN", "STAG", "COLD", "CUBE", "LSI", "EXR",
    # SaaS / cloud / cybersec
    "ZM", "DOCU", "TWLO", "HUBS", "NET", "DDOG", "MDB", "CRWD", "ZS", "OKTA",
    "PANW", "S", "ESTC", "GTLB", "SMAR", "VEEV", "NOW", "WDAY", "TEAM",
]

# ---------- Cryptos ----------
_CRYPTOS_RAW = [
    "bitcoin", "ethereum", "tether", "binancecoin", "solana", "usd-coin",
    "ripple", "cardano", "avalanche-2", "dogecoin", "shiba-inu", "polkadot",
    "chainlink", "tron", "near", "matic-network", "litecoin", "wrapped-bitcoin",
    "dai", "bitcoin-cash", "stellar", "monero", "ethereum-classic", "filecoin",
    "aptos", "arbitrum", "optimism", "cosmos", "vechain", "algorand",
    "internet-computer", "hedera-hashgraph", "the-sandbox", "decentraland",
    "axie-infinity", "aave", "uniswap", "maker", "compound-governance-token", "sushi",
    "curve-dao-token", "balancer", "yearn-finance", "havven",
    "1inch", "pancakeswap-token", "thorchain", "terra-luna-2", "injective-protocol",
    "sui", "sei-network", "blur", "pepe", "floki",
    # DeFi
    "lido-dao", "rocket-pool", "frax-share", "convex-finance", "liquity-usd",
    # Layer 2 / scaling
    "loopring", "immutable-x", "metis-token", "boba-network", "cartesi",
    "skale", "celer-network",
    # Gaming / NFT
    "gala", "illuvium", "star-atlas", "gods-unchained", "splinterlands",
    "my-neighbor-alice", "alien-worlds", "ultra", "wax", "enjincoin",
    # Infrastructure
    "the-graph", "helium", "livepeer", "arweave", "storj", "siacoin", "ankr",
    "band-protocol", "api3",
    # Stablecoin ecosystem
    "frax", "magic-internet-money", "alchemix",
    # Memes / social
    "dogwifcoin", "bonk", "book-of-meme", "brett",
    # Newer L1 / L2
    "worldcoin-wld", "celestia", "mantle", "starknet", "scroll",
    "zksync", "polygon-zkevm", "taiko", "blast", "manta-network",
    "merlin-chain",
]

# ---------- ETFs ----------
_ETFS_RAW = [
    # USA broad market
    "SPY", "IVV", "VOO", "VTI", "QQQ", "IWM", "DIA", "MDY", "IJR", "IJH",
    # Sector USA
    "XLK", "XLF", "XLV", "XLE", "XLI", "XLY", "XLP", "XLU", "XLRE", "XLB", "XLC",
    "VGT", "VFH", "VHT", "VDE", "VIS", "VCR", "VDC", "VPU", "VNQ", "VAW", "VOX",
    # International
    "EFA", "VEA", "IEFA", "SCHF", "VWO", "EEM", "IEMG", "SCHE",
    "EWJ", "EWZ", "EWC", "EWU", "EWG", "EWL", "EWQ", "EWI", "EWP", "EWD",
    "MCHI", "ASHR", "FXI", "EWY", "EWT", "INDA", "EWA", "EZA", "EWW", "EWH",
    # Fixed income
    "BND", "AGG", "LQD", "HYG", "JNK", "TLT", "IEF", "SHY", "BNDX", "EMB",
    "VCIT", "VCSH", "VCLT", "BSV", "BIV", "BLV", "GOVT", "IGIB", "IGSB", "IGLB",
    # Factor / smart beta
    "MTUM", "QUAL", "VLUE", "SIZE", "USMV", "EFAV", "EEMV", "ACWV",
    "DGRW", "DGRO", "VIG", "SDY", "DVY", "HDV", "NOBL", "SPHD", "SCHD",
    # Thematic
    "ARKK", "ARKW", "ARKG", "ARKF", "ARKQ", "ARKX",
    "BOTZ", "ROBO", "IRBO", "AIQ", "DTEC",
    "ICLN", "QCLN", "TAN", "FAN", "ACES", "SMOG",
    "HACK", "CIBR", "BUG", "WCLD", "CLOU", "SKYY",
    "XBI", "IBB", "IDNA", "GNOM", "HELX",
    # Leveraged
    "TQQQ", "SQQQ", "SPXL", "SPXS", "UPRO", "SPXU", "TNA", "TZA", "FAS", "FAZ",
    # Commodities ETFs
    "GLD", "IAU", "SLV", "PSLV", "GDX", "GDXJ", "USO", "BNO", "DBO", "UNG",
    "DJP", "PDBC", "COMT", "BCI", "FTGC", "TAGS", "WEAT", "CORN", "SOYB",
    # Spot crypto ETFs
    "IBIT", "FBTC", "GBTC", "BITB", "HODL", "BTCO", "BITO", "BITI", "ETHE",
    # Europe-listed (LSE / Euronext)
    "VWRL.L", "VUSA.L", "VAGP.L", "VHYL.L", "VJPN.L", "VEUR.L", "VFEM.L",
    "CSP1.L", "CSPX.L", "SWRD.L", "IWDG.L", "EMIM.L", "SGLN.L", "PHAU.L",
    # Income-oriented
    "QYLD", "RYLD", "XYLD", "JEPI", "JEPQ", "DIVO", "PEY", "SDEM", "HNDL", "TLTW",
]


def _dedupe(items: list[str]) -> list[str]:
    return list(dict.fromkeys(items))


TOP_STOCKS = _dedupe(_STOCKS_RAW)
TOP_CRYPTOS = _dedupe(_CRYPTOS_RAW)
TOP_ETFS = _dedupe(_ETFS_RAW)


# ---------- Light metadata for richer UI ----------
# Sector mapping for stocks (subset; rest fall back to "Other"). Country inferred
# from suffix (.SW=CH, .PA=FR, .DE=DE, .L=UK, .HK=HK, .T=JP, .KS=KR, .NS=IN,
# .TO=CA, .AX=AU, .MC=ES, no suffix=US/global ADR).
SECTOR = {
    "AAPL": "Technology", "MSFT": "Technology", "NVDA": "Technology", "AVGO": "Technology",
    "GOOGL": "Communication", "META": "Communication", "NFLX": "Communication", "DIS": "Communication", "T": "Communication", "VZ": "Communication",
    "AMZN": "Consumer Discretionary", "TSLA": "Consumer Discretionary", "HD": "Consumer Discretionary", "MCD": "Consumer Discretionary", "NKE": "Consumer Discretionary", "SBUX": "Consumer Discretionary", "TGT": "Consumer Discretionary",
    "JPM": "Financials", "BAC": "Financials", "MS": "Financials", "GS": "Financials", "BLK": "Financials", "C": "Financials", "AXP": "Financials", "V": "Financials", "MA": "Financials", "USB": "Financials", "WFC": "Financials", "CB": "Financials", "MMC": "Financials", "PGR": "Financials", "SPGI": "Financials",
    "UNH": "Healthcare", "LLY": "Healthcare", "JNJ": "Healthcare", "PFE": "Healthcare", "ABBV": "Healthcare", "MRK": "Healthcare", "TMO": "Healthcare", "ABT": "Healthcare", "DHR": "Healthcare", "BMY": "Healthcare", "AMGN": "Healthcare", "ISRG": "Healthcare", "SYK": "Healthcare", "ZTS": "Healthcare", "HCA": "Healthcare", "CI": "Healthcare", "VEEV": "Healthcare",
    "XOM": "Energy", "CVX": "Energy", "EOG": "Energy", "OXY": "Energy",
    "PG": "Consumer Staples", "KO": "Consumer Staples", "PEP": "Consumer Staples", "WMT": "Consumer Staples", "COST": "Consumer Staples", "MO": "Consumer Staples", "MDLZ": "Consumer Staples", "PM": "Consumer Staples",
    "HON": "Industrials", "RTX": "Industrials", "UPS": "Industrials", "F": "Industrials", "GM": "Industrials",
    "LIN": "Materials", "FCX": "Materials",
    "NEE": "Utilities",
    "PLD": "Real Estate", "AMT": "Real Estate", "EQIX": "Real Estate", "SPG": "Real Estate", "CCI": "Real Estate", "PSA": "Real Estate", "WELL": "Real Estate", "AVB": "Real Estate", "EQR": "Real Estate", "VTR": "Real Estate", "DLR": "Real Estate", "IRM": "Real Estate", "WPC": "Real Estate", "NNN": "Real Estate", "STAG": "Real Estate", "COLD": "Real Estate", "CUBE": "Real Estate", "LSI": "Real Estate", "EXR": "Real Estate", "O": "Real Estate",
    "ZM": "Technology", "DOCU": "Technology", "TWLO": "Technology", "HUBS": "Technology", "NET": "Technology", "DDOG": "Technology", "MDB": "Technology", "CRWD": "Technology", "ZS": "Technology", "OKTA": "Technology", "PANW": "Technology", "S": "Technology", "ESTC": "Technology", "GTLB": "Technology", "SMAR": "Technology", "NOW": "Technology", "WDAY": "Technology", "TEAM": "Technology", "ADBE": "Technology", "ORCL": "Technology", "CSCO": "Technology", "TXN": "Technology", "INTC": "Technology", "QCOM": "Technology", "AMD": "Technology", "CRM": "Technology", "PYPL": "Technology", "SQ": "Technology", "COIN": "Technology", "PLTR": "Technology", "SNOW": "Technology", "UBER": "Technology", "LYFT": "Technology", "ABNB": "Technology", "DASH": "Technology", "RBLX": "Technology", "ATVI": "Communication", "RIVN": "Consumer Discretionary", "SHOP": "Technology",
}


def country_of(symbol: str) -> str:
    suffix_map = {
        ".SW": "CH", ".PA": "FR", ".DE": "DE", ".L": "UK",
        ".HK": "HK", ".T": "JP", ".KS": "KR", ".NS": "IN",
        ".TO": "CA", ".AX": "AU", ".MC": "ES",
    }
    for suf, country in suffix_map.items():
        if symbol.endswith(suf):
            return country
    return "US"


# ETF category mapping (subset; rest fall back to "Other").
ETF_CATEGORY = {
    # Broad / total market
    **dict.fromkeys(["SPY", "IVV", "VOO", "VTI", "QQQ", "IWM", "DIA", "MDY", "IJR", "IJH"], "Broad market"),
    # Sectors
    **dict.fromkeys(["XLK", "XLF", "XLV", "XLE", "XLI", "XLY", "XLP", "XLU", "XLRE", "XLB", "XLC", "VGT", "VFH", "VHT", "VDE", "VIS", "VCR", "VDC", "VPU", "VNQ", "VAW", "VOX"], "Sector"),
    # International
    **dict.fromkeys(["EFA", "VEA", "IEFA", "SCHF", "VWO", "EEM", "IEMG", "SCHE", "EWJ", "EWZ", "EWC", "EWU", "EWG", "EWL", "EWQ", "EWI", "EWP", "EWD", "MCHI", "ASHR", "FXI", "EWY", "EWT", "INDA", "EWA", "EZA", "EWW", "EWH"], "International"),
    # Fixed income
    **dict.fromkeys(["BND", "AGG", "LQD", "HYG", "JNK", "TLT", "IEF", "SHY", "BNDX", "EMB", "VCIT", "VCSH", "VCLT", "BSV", "BIV", "BLV", "GOVT", "IGIB", "IGSB", "IGLB"], "Bond"),
    # Smart beta / factor
    **dict.fromkeys(["MTUM", "QUAL", "VLUE", "SIZE", "USMV", "EFAV", "EEMV", "ACWV", "DGRW", "DGRO", "VIG", "SDY", "DVY", "HDV", "NOBL", "SPHD", "SCHD"], "Smart beta"),
    # Thematic
    **dict.fromkeys(["ARKK", "ARKW", "ARKG", "ARKF", "ARKQ", "ARKX", "BOTZ", "ROBO", "IRBO", "AIQ", "DTEC", "ICLN", "QCLN", "TAN", "FAN", "ACES", "SMOG", "HACK", "CIBR", "BUG", "WCLD", "CLOU", "SKYY", "XBI", "IBB", "IDNA", "GNOM", "HELX"], "Thematic"),
    # Leveraged / inverse
    **dict.fromkeys(["TQQQ", "SQQQ", "SPXL", "SPXS", "UPRO", "SPXU", "TNA", "TZA", "FAS", "FAZ"], "Leveraged"),
    # Commodity
    **dict.fromkeys(["GLD", "IAU", "SLV", "PSLV", "GDX", "GDXJ", "USO", "BNO", "DBO", "UNG", "DJP", "PDBC", "COMT", "BCI", "FTGC", "TAGS", "WEAT", "CORN", "SOYB"], "Commodity"),
    # Crypto-spot
    **dict.fromkeys(["IBIT", "FBTC", "GBTC", "BITB", "HODL", "BTCO", "BITO", "BITI", "ETHE"], "Crypto"),
    # Income / covered call
    **dict.fromkeys(["QYLD", "RYLD", "XYLD", "JEPI", "JEPQ", "DIVO", "PEY", "SDEM", "HNDL", "TLTW"], "Income"),
}


def etf_region(symbol: str) -> str:
    if symbol.endswith(".L"):
        return "Europe"
    return "USA"
