import { BigNumber, ethers } from "ethers";
import { GenericMarketMakingBot, applyInventoryManagement } from "./GenericMarketMakingBot";
import { BotConfiguration } from "../../configuration/config";
import { RiskMinimizedStrategy } from "../../strategies/marketMaking/riskMinimizedUpOnly";
import { TargetVenueOutBidStrategy } from "../../strategies/marketMaking/targetVenueOutBid";
import { formatUnits, parseUnits } from "ethers/lib/utils";
import { EventEmitter } from "stream";
import { Call } from "./BatchStrategyExecutor";

class BatchableGenericMarketMakingBot extends GenericMarketMakingBot {
    eventEmitter: EventEmitter;

    constructor(config: BotConfiguration, marketAid: ethers.Contract, strategy: RiskMinimizedStrategy | TargetVenueOutBidStrategy, _botAddy: string,) { // Replace 'any' with the appropriate type for the options parameter
        console.log("BatchableGenericMarketMakingBot spinning up...");
        console.log("this strategy", strategy.identifier);


        super(config, marketAid, strategy, _botAddy);

        this.eventEmitter = new EventEmitter();

    }

    // Override placeInitialMarketMakingTrades
    override async placeInitialMarketMakingTrades(): Promise<void> {
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
        // Encode the function data for batchPlaceInitialMarketMakingTrades
        const calldata = this.marketAid.interface.encodeFunctionData("placeMarketMakingTrades(address[2],uint256[],uint256[],uint256[],uint256[])", [
            [this.assetPair.asset.address, this.assetPair.quote.address],
            askNumerators,
            askDenominators,
            bidNumerators,
            bidDenominators,
        ]);

        // Emit the event with the encoded function data for further processing
        this.eventEmitter.emit('placeInitialMarketMakingTrades', calldata as unknown as Call);

        console.log("Emitted placeInitialMarketMakingTrades, now waiting for 2 seconds to avoid spam...");

        // Hold execution here and set a timeout to avoid spamming before moving forward
        await new Promise(r => setTimeout(r, 2000)); // Should be block time
    }

    // Add any new methods or properties specific to the BatchableGenericMarketMakingBot class
    // Function that calls requote() on the market-aid
    override async requoteMarketAidPosition(): Promise<void> {
        console.log("\nRequoting market aid position to match the strategy book");
        // TODO: implement web3 call to requote()
        console.log(this.strategy.identifier, "target this book with batchRequote", this.strategy.targetBook);
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
        if (this.requotingOutstandingBook) return;

        this.requotingOutstandingBook = true;

        // Encode the function data for batchRequoteOffers
        const calldata = this.marketAid.interface.encodeFunctionData("batchRequoteOffers(uint256[],address[2],uint256[],uint256[],uint256[],uint256[])", [
            strategistTradeIDs,
            [this.assetPair.asset.address, this.assetPair.quote.address],
            askNumerators,
            askDenominators,
            bidNumerators,
            bidDenominators,
        ]);

        // Emit the event with the encoded function data for further processing
        this.eventEmitter.emit('requoteMarketAidPosition', calldata as unknown as Call);

        console.log("Emitted requoteMarketAidPosition, now waiting for 2 seconds to avoid spam...");

        // Hold execution here and set a timeout to avoid spamming before moving forward
        await new Promise(r => setTimeout(r, 2000)); // Should be block time

        // naive spam mode
        this.requotingOutstandingBook = false;
    }

    override async wipeOnChainBook(): Promise<boolean | void> {
        // Wipe this.marketAidPositionTracker.onChainBookWithData !!!
        // TODO: Logic Gate to avoid spam
        // This can be called in normal operations or if ever needed on GLOBAL TIMEOUT for rebalancing
        console.log("WIPE THE ON-CHAIN BOOK!!!");

        if (this.marketAidPositionTracker.onChainBook.length == 0) {
            console.log("RETURN BC NO OC BOOK", this.marketAidPositionTracker.onChainBook);
            return;
        }
        if (this.wipingOutstandingBook) return;

        // Encode the function data for scrubStrategistTrades
        const calldata = this.marketAid.interface.encodeFunctionData("scrubStrategistTrades", [
            this.marketAidPositionTracker.onChainBook
        ]);

        // Emit the event with the encoded function data for further processing
        this.eventEmitter.emit('wipeOnChainBook', calldata as unknown as Call);

        console.log("Emitted wipeOnChainBook event...");
    }
}

export default BatchableGenericMarketMakingBot;
