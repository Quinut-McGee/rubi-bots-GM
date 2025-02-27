// Execution client object that listens to the price feed coming from a Strategy object and executes orders on a Liquidity Venue object
// Has a function called inventoryMangagement that listens to this.relativeAssetBalance and this.relativeQuoteBalance to determine biases for market-making behavior
// Has a function called execute that listens to the strategy's targetBook and executes orders on the liquidity venue once the strategy's targetBook is different 
// enough based on a configurable threshold from the liquidity venue's liveBook

import { BigNumber, ethers } from "ethers";
import { BotConfiguration, TransactionResponse, marketAddressesByNetwork } from "../../configuration/config";
import { GenericMarketMakingStrategy } from "../../strategies/marketMaking/genericMarketMaking";
import { AssetPair, GenericLiquidityVenue } from "../../liquidityVenues/generic";
import { TargetVenueOutBidStrategy } from "../../strategies/marketMaking/targetVenueOutBid";
import { RiskMinimizedStrategy } from "../../strategies/marketMaking/riskMinimizedUpOnly";
import { UniswapLiquidityVenue } from "../../liquidityVenues/uniswap";
import { MarketAidPositionTracker } from "../../liquidityVenues/rubicon/MarketAidPositionTracker";
import { formatUnits, getAddress, parseUnits } from "ethers/lib/utils";
import MARKET_INTERFACE from "../../configuration/abis/Market";
import { NonceManager } from "@ethersproject/experimental";
import { updateNonceManagerTip } from "../../utilities";


export type MarketAidAvailableLiquidity = {
    quoteWeiAmount: BigNumber,
    assetWeiAmount: BigNumber,
    status: boolean
};


// Takes a configuration, market aid instance, and strategy in the constructor
export class GenericMarketMakingBot {
    config: BotConfiguration;
    marketAid: ethers.Contract;
    strategy: RiskMinimizedStrategy | TargetVenueOutBidStrategy;
    liquidityVenue: GenericLiquidityVenue; // TODO: MAKE RUBICON MARKET-AID BOOSTED LIQUIDITY VENUE FUNCTIONS

    // ** Market Aid Liquidity **
    availableLiquidity: MarketAidAvailableLiquidity;
    relativeAssetBalance: number;
    relativeQuoteBalance: number;
    inventoryManagement: () => void;
    EOAbotAddress: string;
    assetPair: AssetPair;

    marketAidPositionTracker: MarketAidPositionTracker;

    // Logic gates to help with execution flows
    makingInitialBook: boolean;
    requotingOutstandingBook: boolean;

    marketContract: ethers.Contract;
    wipingOutstandingBook: any;

    constructor(config: BotConfiguration, marketAid: ethers.Contract, strategy: RiskMinimizedStrategy | TargetVenueOutBidStrategy, _botAddy: string, liquidityVenue?: GenericLiquidityVenue) {
        this.config = config;
        this.marketAid = marketAid;
        this.strategy = strategy;
        this.liquidityVenue = liquidityVenue;
        this.relativeAssetBalance = 0;
        this.relativeQuoteBalance = 0;
        this.availableLiquidity = <MarketAidAvailableLiquidity>{};
        this.EOAbotAddress = _botAddy;
        this.assetPair = {
            asset: this.config.targetTokens[0],
            quote: this.config.targetTokens[1]
        };
        // If any params passed to the constructor are undefined, throw an error
        if (config === undefined || marketAid === undefined || _botAddy === undefined || this.assetPair === undefined) {
            throw new Error("GenericMarketMakingBot constructor params cannot be undefined");
        }
        const _marketAidPositionTracker = new MarketAidPositionTracker(this.assetPair, this.marketAid, this.EOAbotAddress, this.config);
        this.marketAidPositionTracker = _marketAidPositionTracker;

        this.marketContract = new ethers.Contract(
            marketAddressesByNetwork[this.config.network],
            MARKET_INTERFACE,
            this.config.connections.websocketProvider ? this.config.connections.websocketProvider : this.config.connections.jsonRpcProvider
        );

        if (process.env.LOG_TOGGLE === 'toggleOff') {
            console.log("\n BOT IS STARTING IN SEEMINGLY GOOD STATE - TURNING OFF ALL LOGS FOR PRODUCTION BOOST... gl anon");
            console.log("KEEPING LOGS OFF!!!");
            console.log = () => { };
        }
    }


    // Function that updates the on-chain book on the liquidity venue based on the strategy's targetBook
    // updateOnChainBook() {


    // Start function that kicks off the logical polling sequence that represents the bot's execution
    async launchBot() {
        // See if we can listen to the underlying strategy's recomended price
        console.log('Launching bot');

        // 1. Get the strategist's available liquidity over time
        await this.pullOnChainLiquidity(this.EOAbotAddress);
        // UPDATER - Poll the strategist's total liquidity every second and populate the availableLiquidity object
        setTimeout(() => {
            this.pullOnChainLiquidity(this.EOAbotAddress);
        }, 1000); // TODO: move to config

        // Call a function that takes available liquidity and generates a ladder based on a configurable parameter step size
        // var _uniQueryLadder = getLadderFromAvailableLiquidity(this.availableLiquidity, 5);
        // console.log("This ladder!", _uniQueryLadder);


        // and this.availableLiquidity to get information on the current state of the market via pollLiveBook
        // var assetLadder = _uniQueryLadder.assetLadder;
        // var quoteLadder = _uniQueryLadder.quoteLadder;

        (this.strategy.referenceLiquidityVenue as UniswapLiquidityVenue).pollLiveBook(
            async () => {
                // Refresh availableLiquidity and get the updated assetLadder based on it
                await this.pullOnChainLiquidity(this.EOAbotAddress);
                const _uniQueryLadder = getLadderFromAvailableLiquidity(this.availableLiquidity, 5);
                // Print the formatted ladder
                return _uniQueryLadder;
            },
            2000
        );

        this.strategy.updateNotifier.on('update', (liveBook) => {
            console.log('\nStrategy Feed updated!');
            // console.log(liveBook);
            this.compareStrategyAndMarketAidBooks();
        });

        // Kickoff a listener that polls the market-aid for the current state of the market
        // MarketAidPositionTracker will drive a book we compare against strategy book to do everything
        this.marketAidPositionTracker.updateNotifier.on('update', (liveBook) => {
            console.log('\nMarket Aid Position Tracker Feed updated!');
            console.log(liveBook);
            this.compareStrategyAndMarketAidBooks();
        });

        // Check the type of this.strategy, and if it is RiskMinimizedStrategy, then call the function tailOffModule on this
        if (this.strategy instanceof RiskMinimizedStrategy) {
            this.tailOffModule();
        }
    }

    // Main logical function that executes orders on the liquidity venue based on the strategy's targetBook
    compareStrategyAndMarketAidBooks() {
        // Compare the strategy's targetBook with the market-aid's liveBook
        // If the strategy's targetBook is different enough from the market-aid's liveBook, then execute orders on the liquidity venue to match
        const strategyBook = this.strategy.targetBook;
        const marketAidBook = this.marketAidPositionTracker.liveBook;
        // TODO: solve for this better
        const deltaTrigger = 0.003; // Relative difference in price between the strategy's targetBook and the market-aid's liveBook that triggers an order execution

        const askLiquidityThreshold = parseFloat(formatUnits(this.availableLiquidity.assetWeiAmount, this.assetPair.asset.decimals));
        const bidLiquidityThreshold = parseFloat(formatUnits(this.availableLiquidity.quoteWeiAmount, this.assetPair.quote.decimals));

        // Log values
        console.log('True Available liquidity:', { ask: askLiquidityThreshold, bid: bidLiquidityThreshold });
        if (strategyBook === undefined || strategyBook.asks == undefined || marketAidBook === undefined || strategyBook.bids == undefined) {
            console.log('No books to compare');
            return;
        }


        // Check if the total size of asks or bids in strategy book exceeds the available liquidity
        const totalAskSize = strategyBook.asks.reduce((acc, ask) => acc + ask.size, 0);
        // Convert totalBidSize from asset amount to quote amount
        const totalBidSize = strategyBook.bids.reduce((acc, bid) => acc + (bid.size * bid.price), 0);
        if (totalAskSize > askLiquidityThreshold || totalBidSize > bidLiquidityThreshold) {
            console.log('Strategy book size exceeds available liquidity threshold');
            const askScaleFactor = askLiquidityThreshold / totalAskSize;
            // Log values
            console.log(
                'askLiquidityThreshold:',
                askLiquidityThreshold,
                'totalAskSize:',
                totalAskSize,
            );

            console.log(
                'bidLiquidityThreshold:',
                bidLiquidityThreshold,
                'totalBidSize:',
                totalBidSize,
            );


            const bidScaleFactor = bidLiquidityThreshold / totalBidSize;
            console.log('Scaling strategy book by factors:', { ask: askScaleFactor, bid: bidScaleFactor });

            // Scale the sizes of the offers in the book
            strategyBook.asks = strategyBook.asks.map(ask => ({ price: ask.price, size: ask.size * askScaleFactor }));
            strategyBook.bids = strategyBook.bids.map(bid => ({ price: bid.price, size: bid.size * bidScaleFactor }));
        }


        // Check if the asks and the bids are not defined in both books
        // Both books have defined values for asks and bids
        if (strategyBook.asks !== undefined && strategyBook.bids !== undefined && marketAidBook.asks !== undefined && marketAidBook.bids !== undefined) {
            console.log("Comparing books");
            console.log("Strategy Book", strategyBook);
            console.log(this.strategy.identifier, "Market Aid Book", marketAidBook);

            // If the asks and bids of marketAidBook are empty then we call placeInitialMarketMakingTrades()
            if (marketAidBook.asks.length === 0 && marketAidBook.bids.length === 0) {
                console.log("Market Aid book is empty, placing initial market making trades");
                this.placeInitialMarketMakingTrades();
            }
            // If the asks and the bids of marketAidBook are non-empty then check if they are equal in length to the strategyBook
            else if (marketAidBook.asks.length === strategyBook.asks.length && marketAidBook.bids.length === strategyBook.bids.length) {
                console.log("Market Aid book is same length as strategy book, checking for price deltas....");

                // Check the differential between the strategyBook and the marketAidBook offers and call updateMarketAidPosition() if the differential is greater than deltaTrigger
                for (let i = 0; i < strategyBook.asks.length; i++) {
                    const strategyAsk = strategyBook.asks[i];
                    const marketAidAsk = marketAidBook.asks[i];
                    const strategyAskPrice = isNaN(strategyAsk.price) ? 0 : strategyAsk.price;
                    const marketAidAskPrice = isNaN(marketAidAsk.price) ? 0 : marketAidAsk.price;
                    const askDelta = Math.abs(strategyAskPrice - marketAidAskPrice) / strategyAskPrice;

                    if (askDelta > deltaTrigger) {
                        console.log("Ask delta is greater than deltaTrigger, updating market aid position");
                        this.requoteMarketAidPosition();
                    }
                }

                for (let i = 0; i < strategyBook.bids.length; i++) {
                    const strategyBid = strategyBook.bids[i];
                    const marketAidBid = marketAidBook.bids[i];
                    const strategyBidPrice = isNaN(strategyBid.price) ? 0 : strategyBid.price;
                    const marketAidBidPrice = isNaN(marketAidBid.price) ? 0 : marketAidBid.price;
                    const bidDelta = Math.abs(strategyBidPrice - marketAidBidPrice) / strategyBidPrice;

                    if (bidDelta > deltaTrigger) {
                        console.log("Bid delta is greater than deltaTrigger, updating market aid position");
                        this.requoteMarketAidPosition();
                    }
                }
            }

            // If the asks and the bids of marketAidBook are non-empty but are not equal in length to the strategyBook
            else if (marketAidBook.asks.length !== strategyBook.asks.length || marketAidBook.bids.length !== strategyBook.bids.length) {
                // Check if the marketAidBook is greater in length than the target book
                if (marketAidBook.asks.length > strategyBook.asks.length || marketAidBook.bids.length > strategyBook.bids.length) {
                    // Wipe the book
                    console.log("Market Aid book is greater in length than the target book, wiping the on-chain book");
                    this.wipeOnChainBook();
                } else {
                    // TODO: Make sure disjoint strateTradeID.lengths and target requote liquidity curve can work...
                    // For now do nothing here
                    // this.requoteMarketAidPosition();

                    // Until we can requote where targets.length != desiredLiquidity curve.length, we will wipe the book
                    console.log("Market Aid book is less in length than the target book, wiping the on-chain book");
                    this.wipeOnChainBook();
                }
            }
        }
    }

    // Function that calls requote() on the market-aid
    requoteMarketAidPosition(): void {
        console.log("\nRequoting market aid position to match the strategy book");
        // TODO: implement web3 call to requote()
        console.log("target this book with batchRequote", this.strategy.targetBook);
        console.log("Need to update from this book", this.marketAidPositionTracker.liveBook);

        // Grab all of the strategist trade IDs from MarketAid position tracker
        const strategistTradeIDs: BigNumber[] = [];
        for (let i = 0; i < this.marketAidPositionTracker.onChainBookWithData.length; i++) {
            strategistTradeIDs.push(this.marketAidPositionTracker.onChainBookWithData[i].stratTradeID);
        }

        console.log("These are the relevant ids", strategistTradeIDs);
        // Print the map formatted
        console.log("these ids formatted", strategistTradeIDs.map((id) => id.toString()));

        // TODO: only on targetVenueOutBid???
        let assetSideBias = 1;
        let quoteSideBias = 1;

        if (this.strategy instanceof TargetVenueOutBidStrategy) {
            const { assetSideBias: calculatedAssetSideBias, quoteSideBias: calculatedQuoteSideBias } = applyInventoryManagement(this.relativeAssetBalance, this.relativeQuoteBalance);
            assetSideBias = calculatedAssetSideBias;
            quoteSideBias = calculatedQuoteSideBias;
        }        // const assetSideBias = 1;
        // const quoteSideBias = 1;
        console.log("\n APPLY THESE BIASES, asset, quote", assetSideBias, quoteSideBias);

        var askNumerators = [];
        var askDenominators = [];
        var bidNumerators = [];
        var bidDenominators = [];
        // TODO: adapt this to drive on batchRequote
        // ************************************
        // TODO: check that this works?
        for (let index = 0; index < this.strategy.targetBook.asks.length; index++) {
            const ask = this.strategy.targetBook.asks[index];
            const askNumerator = parseUnits((this.strategy.targetBook.asks[index].size * assetSideBias).toFixed(this.assetPair.asset.decimals), this.assetPair.asset.decimals);
            const askDenominator = parseUnits((this.strategy.targetBook.asks[index].price * (this.strategy.targetBook.asks[index].size * assetSideBias)).toFixed(this.assetPair.quote.decimals), this.assetPair.quote.decimals);
            const bidNumerator = parseUnits((this.strategy.targetBook.bids[index].price * (this.strategy.targetBook.bids[index].size * quoteSideBias)).toFixed(this.assetPair.quote.decimals), this.assetPair.quote.decimals);
            const bidDenominator = parseUnits((this.strategy.targetBook.bids[index].size * quoteSideBias).toFixed(this.assetPair.asset.decimals), this.assetPair.asset.decimals);

            askNumerators.push(askNumerator);
            askDenominators.push(askDenominator);
            bidNumerators.push(bidNumerator);
            bidDenominators.push(bidDenominator);

        }


        // New code to print out the price of each trade
        for (let i = 0; i < askNumerators.length; i++) {
            const askPrice = parseFloat(formatUnits(askDenominators[i], this.assetPair.quote.decimals)) / parseFloat(formatUnits(askNumerators[i], this.assetPair.asset.decimals));
            const bidPrice = parseFloat(formatUnits(bidNumerators[i], this.assetPair.quote.decimals)) / parseFloat(formatUnits(bidDenominators[i], this.assetPair.asset.decimals));

            console.log(`Ask price for trade ${i + 1}: ${askPrice}`);
            console.log(`Bid price for trade ${i + 1}: ${bidPrice}`);
        }
        // const askNumerator = parseUnits((this.strategy.targetBook.asks[index].size * assetSideBias).toFixed(this.assetPair.asset.decimals), this.assetPair.asset.decimals);
        // const askDenominator = parseUnits((this.strategy.targetBook.asks[0].price * (this.strategy.targetBook.asks[0].size * assetSideBias)).toFixed(this.assetPair.quote.decimals), this.assetPair.quote.decimals);
        // const bidNumerator = parseUnits((this.strategy.targetBook.bids[0].price * (this.strategy.targetBook.bids[0].size * quoteSideBias)).toFixed(this.assetPair.quote.decimals), this.assetPair.quote.decimals);
        // const bidDenominator = parseUnits((this.strategy.targetBook.bids[0].size * quoteSideBias).toFixed(this.assetPair.asset.decimals), this.assetPair.asset.decimals);

        // // TODO: we need to know the relevant strategist trade ID to pass into requote()
        if (this.requotingOutstandingBook) return;
        // Note, conversely batchRequoteAllOffers could be used
        // console.log(this.marketAid.connect(this.config.connections.signer).estimateGas);


        // LOG ALL INPUTS
        console.log("strategistTradeIDs", strategistTradeIDs.map((n) => n.toString()));
        console.log("this.assetPair.asset.address", this.assetPair.asset.address);
        console.log("this.assetPair.quote.address", this.assetPair.quote.address);
        console.log("askNumerators", askNumerators.map((n) => formatUnits(n, this.assetPair.asset.decimals)));
        console.log("askDenominators", askDenominators.map((n) => formatUnits(n, this.assetPair.quote.decimals)));
        console.log("bidNumerators", bidNumerators.map((n) => formatUnits(n, this.assetPair.quote.decimals)));
        console.log("bidDenominators", bidDenominators.map((n) => formatUnits(n, this.assetPair.asset.decimals)));

        // this.marketAid.connect(this.config.connections.signer).estimateGas['batchRequoteOffers(uint256[],address[2],uint256[],uint256[],uint256[],uint256[])'](
        //     strategistTradeIDs,
        //     [this.assetPair.asset.address, this.assetPair.quote.address],
        //     askNumerators,
        //     askDenominators,
        //     bidNumerators,
        //     bidDenominators,
        // ).then((r) => {
        // if (r) {
        if (this.requotingOutstandingBook) return;

        this.requotingOutstandingBook = true;

        this.marketAid.connect(this.config.connections.signer)['batchRequoteOffers(uint256[],address[2],uint256[],uint256[],uint256[],uint256[])'](
            strategistTradeIDs,
            [this.assetPair.asset.address, this.assetPair.quote.address],
            askNumerators,
            askDenominators,
            bidNumerators,
            bidDenominators,
        ).then(async (r) => {
            const out = await r.wait();
            this.requotingOutstandingBook = false;

            if (out.status == true) {
                console.log("\nREQUOTE SUCCESSFUL!!!! 🎉");
                // TODO??? Chase the transaction and update what info on this we can
            }

        }).catch((e) => {
            console.log("This error IN SHIPPING REQUOTE", e);
            this.requotingOutstandingBook = false;
            this.pullOnChainLiquidity(this.EOAbotAddress);
            // updateNonceManagerTip(this.config.signer as NonceManager, this.config.connections.reader);
        })
        // }
        // }).catch((e) => {
        //     console.log("This error estimating REQUOTE gas", e.reason);
        //     // Should this one be here?
        //     // this.requotingOutstandingBook = false;
        //     // updateNonceManagerTip(this.config.signer as NonceManager, this.config.reader);
        // })


    }


    // Function that calls placeMarketMakingTrades() on the market-aid
    placeInitialMarketMakingTrades(): void {
        console.log("\nInitializing a market aid position to match the strategy book");
        // Target this book
        console.log("target this book with place market making trades", this.strategy.targetBook);

        // Loop through target book, and using the pattern below populate an array of values for askNumerators, askDenominators, bidNumerators, and bidDenominators
        var askNumerators = [];
        var askDenominators = [];
        var bidNumerators = [];
        var bidDenominators = [];

        // Loop through the asks and bids of the target book and populate the above arrays using the pattern below
        for (let i = 0; i < this.strategy.targetBook.asks.length; i++) {
            askNumerators.push(parseUnits(this.strategy.targetBook.asks[i].size.toString(), this.assetPair.asset.decimals));
            askDenominators.push(parseUnits((this.strategy.targetBook.asks[i].price * this.strategy.targetBook.asks[i].size).toFixed(this.assetPair.quote.decimals), this.assetPair.quote.decimals));
        }

        for (let i = 0; i < this.strategy.targetBook.bids.length; i++) {
            bidNumerators.push(parseUnits((this.strategy.targetBook.bids[i].price * this.strategy.targetBook.bids[i].size).toFixed(this.assetPair.quote.decimals), this.assetPair.quote.decimals));
            bidDenominators.push(parseUnits(this.strategy.targetBook.bids[i].size.toString(), this.assetPair.asset.decimals));
        }

        // Here is what a single offer might look like via placeMarketMakingTrades()
        // Note this assumes that strategy.targetBook size all references asset amounts
        // const askNumerator = parseUnits(this.strategy.targetBook.asks[0].size.toString(), this.assetPair.asset.decimals);
        // const askDenominator = parseUnits((this.strategy.targetBook.asks[0].price * this.strategy.targetBook.asks[0].size).toFixed(this.assetPair.quote.decimals), this.assetPair.quote.decimals);
        // const bidNumerator = parseUnits((this.strategy.targetBook.bids[0].price * this.strategy.targetBook.bids[0].size).toFixed(this.assetPair.quote.decimals), this.assetPair.quote.decimals);
        // const bidDenominator = parseUnits(this.strategy.targetBook.bids[0].size.toString(), this.assetPair.asset.decimals);


        if (this.makingInitialBook) {
            console.log("Already making initial book, not making another - 0");
            return
        };
        // console.log(this.marketAid.connect(this.config.connections.signer).estimateGas);

        this.marketAid.connect(this.config.connections.signer).estimateGas['batchMarketMakingTrades(address[2],uint256[],uint256[],uint256[],uint256[])'](
            [this.assetPair.asset.address, this.assetPair.quote.address],
            askNumerators,
            askDenominators,
            bidNumerators,
            bidDenominators
        ).then(async (r) => {

            if (r) {
                if (this.makingInitialBook) {
                    console.log("Already making initial book, not making another - 1");
                    return
                };

                console.log("\nRipping these params",
                    askNumerators.toString(),
                    askDenominators.toString(),
                    bidDenominators.toString(),
                    bidNumerators.toString());

                this.makingInitialBook = true;
                this.marketAid.connect(this.config.connections.signer)['batchMarketMakingTrades(address[2],uint256[],uint256[],uint256[],uint256[])'](
                    [this.assetPair.asset.address, this.assetPair.quote.address],
                    askNumerators,
                    askDenominators,
                    bidNumerators,
                    bidDenominators,
                    { gasLimit: r.add(BigNumber.from(100000)) }
                ).then(async (r: TransactionResponse) => {

                    // console.log("reposns", r);

                    const out = await r.wait();
                    this.makingInitialBook = false;
                    if (out.status == true) {
                        // PlaceMarketMakingTrades and TODO listen to status all the way through to update what you can on the object...
                        console.log("Market-Making Trades Successful!");

                    }
                }).catch((e) => {
                    console.log("🥺 Error shipping place market-making trades!!!", e);
                    this.makingInitialBook = false;
                    // updateNonceManagerTip(this.config.signer as NonceManager, this.config.reader);
                });
            }

        }).catch((e) => {
            console.log("Couldn't estimate gas on place market-marking trades", e);
            // Should this one be included??
            this.makingInitialBook = false;
            // updateNonceManagerTip(this.config.connections.signer as NonceManager, this.config.reader);
        });
    }

    async wipeOnChainBook(): Promise<boolean | void> {
        // Wipe this.marketAidPositionTracker.onChainBookWithData !!!
        // TODO: Logic Gate to avoid spam
        // This can be called in normal operations or if ever needed on GLOBAL TIMEOUT for rebalancing
        console.log("WIPE THE ON-CHAIN BOOK!!!");

        if (this.marketAidPositionTracker.onChainBook.length == 0) {
            console.log("RETURN BC NO OC BOOK", this.marketAidPositionTracker.onChainBook);
            return;
        }
        if (this.wipingOutstandingBook) return;

        console.log("WIPING THE ERRONEOUS book", this.marketAidPositionTracker.onChainBook);


        this.marketAid.connect(this.config.connections.signer).estimateGas.scrubStrategistTrades(
            this.marketAidPositionTracker.onChainBook
        ).then((r) => {
            if (r) {
                if (this.wipingOutstandingBook) return;

                this.wipingOutstandingBook = true;

                this.marketAid.connect(this.config.connections.signer).scrubStrategistTrades(this.marketAidPositionTracker.onChainBook).then(async (r) => {
                    const out = await r.wait();
                    this.wipingOutstandingBook = false;
                    if (out.status == true) {
                        console.log("\n***WIPING THE ERRONEOUS book success");
                    }
                }).catch((e) => {
                    console.log("FAIL ON YEETING WIPE THE BOOK", e);
                    updateNonceManagerTip(this.config.connections.signer as NonceManager, this.config.connections.jsonRpcProvider);
                    this.wipingOutstandingBook = false;
                })
            }
        }).catch((e) => {
            console.log("FAIL ON EG WIPE THE BOOK", e);
            // Should this one be here?
            // this.wipingOutstandingBook = false;
            updateNonceManagerTip(this.config.connections.signer as NonceManager, this.config.connections.jsonRpcProvider);
        })
    }


    pullOnChainLiquidity(strategist: string): Promise<MarketAidAvailableLiquidity> {
        console.log("\nQuery Strategist Total Liquidity ",
            this.config.targetTokens[0].address,
            this.config.targetTokens[1].address,
            strategist,
            this.marketAid.address
        );

        try {
            return this.marketAid.getStrategistTotalLiquidity(
                this.config.targetTokens[0].address,
                this.config.targetTokens[1].address,
                strategist
            ).then((r: MarketAidAvailableLiquidity) => {
                // console.log("Got this after getStratTotalLiquidity", r);

                // Log formatted the response
                console.log("Formatted Liquidity - Asset Amount:", formatUnits(r.assetWeiAmount, 18));
                console.log("Formatted Liquidity - Quote Amount:", formatUnits(r.quoteWeiAmount, 18));

                // Create a new object with the same properties as r
                // TODO: arbitrary scalar here
                const newR: MarketAidAvailableLiquidity = {
                    assetWeiAmount: BigNumber.from(r.assetWeiAmount).mul(10).div(100),
                    quoteWeiAmount: BigNumber.from(r.quoteWeiAmount).mul(10).div(100),
                    status: r.status
                };

                this.availableLiquidity = newR;

                // Relative balance tracking driven off these query results and localbook
                const humanReadableQuoteAmount = parseFloat(formatUnits(this.availableLiquidity.quoteWeiAmount, this.assetPair.quote.decimals));
                const humanReadableAssetAmount = parseFloat(formatUnits(this.availableLiquidity.assetWeiAmount, this.assetPair.asset.decimals));

                if (this.strategy.targetBook !== undefined &&
                    this.strategy.targetBook.asks !== undefined &&
                    this.strategy.targetBook.bids !== undefined &&
                    this.strategy.targetBook.asks.length > 0 &&
                    this.strategy.targetBook.bids.length > 0) {

                    // const humanReadableQuoteAmount = parseFloat(formatUnits(this.availableLiquidity.quoteWeiAmount, this.assetPair.quote.decimals));
                    // const humanReadableAssetAmount = parseFloat(formatUnits(this.availableLiquidity.assetWeiAmount, this.assetPair.asset.decimals));

                    // Calculate the reference price (midpoint)
                    const referencePrice = (this.strategy.targetBook.asks[0].price + this.strategy.targetBook.bids[0].price) / 2;

                    const totalOnChainUSDAmount = humanReadableQuoteAmount + humanReadableAssetAmount * referencePrice;
                    console.log("\n 💰 THIS TOTAL ONCHAIN USD VALUE", totalOnChainUSDAmount, this.assetPair.asset.symbol, "-", this.assetPair.quote.symbol, " 💰");

                    const relativeBalanceAsset = (humanReadableAssetAmount * referencePrice) / totalOnChainUSDAmount;
                    const relativeBalanceQuote = humanReadableQuoteAmount / totalOnChainUSDAmount;
                    console.log("This relative Asset balance", relativeBalanceAsset);
                    console.log("This relative Quote balance", relativeBalanceQuote);

                    // Assign these values to be used in order sizing
                    this.relativeAssetBalance = relativeBalanceAsset;
                    this.relativeQuoteBalance = relativeBalanceQuote;
                } else {
                    console.log("\nNO LOCAL BOOK RETURN or ASKS/BIDS UNDEFINED");
                    this.relativeAssetBalance = undefined;
                    this.relativeQuoteBalance = undefined;
                }

                return newR;
            });
        } catch (error) {
            console.log("\nError in pullOnChainLiquidity", error);
        }
    }


    // *** For use in RiskMinimized Strategy ***
    tailOffModule(): void {
        console.log("Tail off module called");

        console.log("Listening to takes on my orders from this market aid contract", this.marketAid.address);
        console.log("This market", this.marketContract.address);


        const maker = this.marketAid.address;

        // State management idea to prevent multiple takes from being processed
        let aggregateState = {
            assetAmount: BigNumber.from(0),
            quoteAmount: BigNumber.from(0),
            updated: false
        };

        const updateAggregateState = (pay_gem, give_amt, target_asset) => {
            aggregateState.updated = true;
            if (pay_gem == getAddress(this.assetPair.quote.address)) {
                aggregateState.assetAmount = aggregateState.assetAmount.add(give_amt);
            } else if (pay_gem == getAddress(this.assetPair.asset.address)) {
                aggregateState.quoteAmount = aggregateState.quoteAmount.add(give_amt);
            }
        };

        const processAggregateState = async (blocknumber: number) => {
            if (!aggregateState.updated) return;

            if (!aggregateState.assetAmount.isZero()) {
                console.log("Dump total asset amount:", formatUnits(aggregateState.assetAmount, this.assetPair.asset.decimals));
                await this.dumpFillViaMarketAid(this.assetPair.asset.address, aggregateState.assetAmount, this.assetPair.quote.address);
            }

            if (!aggregateState.quoteAmount.isZero()) {
                console.log("Dump total quote amount:", formatUnits(aggregateState.quoteAmount, this.assetPair.quote.decimals));
                await this.dumpFillViaMarketAid(this.assetPair.quote.address, aggregateState.quoteAmount, this.assetPair.asset.address);
            }

            // Reset aggregate state
            aggregateState = {
                assetAmount: BigNumber.from(0),
                quoteAmount: BigNumber.from(0),
                updated: false
            };
        };

        this.marketContract.on(this.marketContract.filters.emitTake(null, null, maker), async (id, pair, maker, taker, pay_gem, buy_gem, take_amt, give_amt, event) => {
            console.log("\n 🎉 GOT THIS INFO FROM THE LOGTAKE FILTER", id, pair, maker, taker, pay_gem, buy_gem, take_amt, give_amt, event);


            console.log("\n 🎉 GOT A RELEVANT LOGTAKE!");
            // TODO: determine exactly what to dump


            if (pay_gem == getAddress(this.assetPair.quote.address) /* && !this.timeoutOnTheField*/) {
                console.log("I AS MAKER JUST BOUGHT SOME ASSET, dump asset on CEX");
                const val = formatUnits(give_amt, this.assetPair.asset.decimals);
                console.log("QUOTE AMOUNT:", formatUnits(take_amt, this.assetPair.quote.decimals));
                console.log("ASSET AMOUNT:", val);

                // writeLogToCsv([val, "🔥🔥🔥 DUMP ON COINBASE", parseFloat(val).toPrecision(3), this.config.asset.symbol, "🔥🔥🔥\n"], getTimestamp(), "FILL_SPOTTED", this.config.asset.address, this.config.quote.address, this.config.strategy)
                console.log("🔥🔥🔥 DUMP ON target", parseFloat(val).toPrecision(3), this.assetPair.asset.symbol, "🔥🔥🔥\n");

                // this.dumpFillViaMarketAid(this.assetPair.asset.address, give_amt, this.assetPair.quote.address);
                updateAggregateState(this.assetPair.asset.address, give_amt, this.assetPair.quote.address);
            } else if (pay_gem == getAddress(this.assetPair.asset.address) /* && !this.timeoutOnTheField*/) {
                console.log("I AS MAKER JUST BOUGHT SOME QUOTE, dump quote on CEX");
                const val = formatUnits(give_amt, this.assetPair.quote.decimals); // TODO: potential precision loss ? idk probs unlikely
                console.log("QUOTE AMOUNT:", val);
                console.log("ASSET AMOUNT:", formatUnits(take_amt, this.assetPair.asset.decimals));

                // writeLogToCsv([val, "🔥🔥🔥 DUMP ON COINBASE", parseFloat(val).toPrecision(3), this.config.quote.symbol, "🔥🔥🔥\n"], getTimestamp(), "FILL_SPOTTED", this.config.asset.address, this.config.quote.address, this.config.strategy)

                // different than above... avoids any price math?
                const valueUsedInTail = (formatUnits(take_amt, this.assetPair.asset.decimals));
                console.log("🔥🔥🔥 DUMP ON target this QUOTE amount", val, "or dump this if NEED asset amount:", valueUsedInTail, this.assetPair.asset.symbol, "🔥🔥🔥\n");

                // Note: BUY THE ASSET AMOUNT ON CEX
                // dumpERC20onFTX(true, parseFloat(valueUsedInTail), this.config.quote.symbol);

                // Call the function at the specified line numbers
                // this.dumpFillViaMarketAid(this.assetPair.quote.address, give_amt, this.assetPair.asset.address);
                updateAggregateState(this.assetPair.quote.address, give_amt, this.assetPair.asset.address);
            }

            // Get the block after the event
            const block = await event.getBlock();
            const nextBlockNumber = block.number + 1;

            // Call processAggregateState with nextBlockNumber as an argument
            processAggregateState(nextBlockNumber);
        });
    }

    // *** For use in RiskMinimized Strategy ***
    async dumpFillViaMarketAid(
        assetToSell: string,
        amountToSell: BigNumber,
        assetToTarget: string,
    ): Promise<boolean | void> {
        const poolFee: number = (this.strategy.getReferenceLiquidityVenue() as UniswapLiquidityVenue).uniFee;

        console.log("Attempting to dump fill via market aid...", assetToSell, amountToSell.toString(), assetToTarget, poolFee);

        try {
            const amountOut: BigNumber = await this.marketAid.connect(this.config.connections.signer as NonceManager).strategistRebalanceFunds(
                assetToSell,
                amountToSell,
                assetToTarget,
                poolFee,
            );
            console.log("\n Succesfully dumped fill!!!!", amountOut.toString(), "of", assetToTarget, "for", amountToSell.toString(), "of", assetToSell, "on", this.strategy.referenceLiquidityVenue.identifier, "with a fee of", poolFee, "%");

        } catch (error) {
            console.error("Error while executing dumpFillViaMarketAid:", error.reason);

            // TODO: Update the nonce and try again if there's a failure...
            // await updateNonceManagerTip((this.config.connections.signer as NonceManager), this.config.connections.jsonRpcProvider)
        }

        return true;
    }
}

export function getLadderFromAvailableLiquidity(availableLiquidity: MarketAidAvailableLiquidity, stepSize: number): { assetLadder: BigNumber[], quoteLadder: BigNumber[] } {
    // console.log("I think this is my available liquidity", availableLiquidity);

    // Print as formatted values
    console.log("I think this is my available liquidity", formatUnits(availableLiquidity.assetWeiAmount, 18), formatUnits(availableLiquidity.quoteWeiAmount, 18));

    // Chat GPT helped me with this lol
    // TODO: update this from linear to exponential
    const s = stepSize * (stepSize + 1) / 2;
    const assetStep = availableLiquidity.assetWeiAmount.div(s);
    const quoteStep = availableLiquidity.quoteWeiAmount.div(s);

    const assetLadder = [];
    const quoteLadder = [];

    let totalProvidedAssetLiquidity = BigNumber.from(0);
    let totalProvidedQuoteLiquidity = BigNumber.from(0);

    for (let i = 1; i <= stepSize; i++) {
        const assetAmount = assetStep.mul(i);
        const quoteAmount = quoteStep.mul(i);

        // Check if providing this amount of liquidity will exceed availableLiquidity
        if (totalProvidedAssetLiquidity.add(assetAmount).gt(availableLiquidity.assetWeiAmount) || totalProvidedQuoteLiquidity.add(quoteAmount).gt(availableLiquidity.quoteWeiAmount)) {
            break;
        }

        assetLadder.push(assetAmount);
        quoteLadder.push(quoteAmount);

        totalProvidedAssetLiquidity = totalProvidedAssetLiquidity.add(assetAmount);
        totalProvidedQuoteLiquidity = totalProvidedQuoteLiquidity.add(quoteAmount);
    }

    // Print out the ladder in human readable format using formatUnits
    // console.log("Asset Ladder", assetLadder.map((a) => formatUnits(a, 18)));
    // console.log("Quote Ladder", quoteLadder.map((a) => formatUnits(a, 18)));


    // Calculate the total asset and quote amounts
    const totalAssetAmount = assetLadder.reduce((acc, curr) => acc.add(curr), BigNumber.from(0));
    const totalQuoteAmount = quoteLadder.reduce((acc, curr) => acc.add(curr), BigNumber.from(0));

    // Log the total amounts in human readable format
    console.log("Total Asset Amount:", formatUnits(totalAssetAmount, 18));
    console.log("Total Quote Amount:", formatUnits(totalQuoteAmount, 18));



    return {
        assetLadder: assetLadder,
        quoteLadder: quoteLadder
    };
}

export function applyInventoryManagement(relativeAssetBalance: number, relativeQuoteBalance: number): { assetSideBias: number, quoteSideBias: number } {
    let assetSideBias = 1;
    let quoteSideBias = 1;

    if (relativeAssetBalance === undefined || relativeQuoteBalance === undefined) {
        console.log("\nFAIL undefined relative balances so WILL NOT REQUOTE");
        return { assetSideBias, quoteSideBias };
    }

    const delta = 0.18;
    const MIN_REL_BAL = 0.5 - delta;
    const MAX_REL_BAL = 0.5 + delta;
    assetSideBias = (relativeAssetBalance - MIN_REL_BAL) / relativeAssetBalance;
    quoteSideBias = (relativeQuoteBalance - MIN_REL_BAL) / relativeQuoteBalance;

    if (assetSideBias < 0) {
        assetSideBias = 0;
    }

    if (quoteSideBias < 0) {
        quoteSideBias = 0;
    }

    if (isNaN(assetSideBias) || isNaN(quoteSideBias)) {
        console.log("\n !!!!!!! FAIL NAN BIASES undefined relative balances so NO BIAS, biases are 1 or the calculated values are nan", assetSideBias, quoteSideBias);
        assetSideBias = 1;
        quoteSideBias = 1;
    }

    console.log("\n APPLY THESE NEW 0.1 BIASES, asset, quote", assetSideBias, quoteSideBias);

    return { assetSideBias, quoteSideBias };
}
