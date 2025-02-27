import { BigNumber, ethers } from 'ethers';
import { EventEmitter } from 'events';
import BatchableGenericMarketMakingBot from './BatchableGenericMarketMakingBot';
import { BotConfiguration } from '../../configuration/config';

// Define the event types that the BatchStrategyExecutor will listen to
interface BatchStrategyExecutorEvents {
  on(event: 'addToBatch', listener: (data: any) => void): this;
  emit(event: 'addToBatch', data: any): boolean;
}

class BatchStrategyExecutor extends (EventEmitter as { new(): BatchStrategyExecutorEvents }) {
  private batch: any[];
  private batchInProgress: boolean;
  private bots: BatchableGenericMarketMakingBot[];
  config: BotConfiguration;
  marketAid: ethers.Contract;
  eventEmitter: EventEmitter;

  constructor(bots: BatchableGenericMarketMakingBot[], config: BotConfiguration, marketAid: ethers.Contract) {
    super();
    this.bots = bots;
    this.batch = new Array(this.bots.length).fill(null).map((_, botId) => ({ botId, actions: {} }));
    this.batchInProgress = false;
    this.config = config;
    this.marketAid = marketAid;
    this.eventEmitter = new EventEmitter();

    // Bind event listeners
    this.on('addToBatch', this.handleAddToBatch);

    console.log("BatchStrategyExecutor spinning up...");

    // Listen to events from all BatchableGenericMarketMakingBot instances
    this.bots.forEach((bot, botIndex) => {
      console.log("Listening to events from bot: ", botIndex);

      bot.launchBot();
      bot.eventEmitter.on('placeInitialMarketMakingTrades', (calldata: string) => {
        this.emit('addToBatch', { botId: botIndex, action: 'placeInitialMarketMakingTrades', calldata });
      });

      bot.eventEmitter.on('requoteMarketAidPosition', (calldata: string) => {
        this.emit('addToBatch', { botId: botIndex, action: 'requoteMarketAidPosition', calldata });
      });

      bot.eventEmitter.on('wipeOnChainBook', (calldata: string) => {
        this.emit('addToBatch', { botId: botIndex, action: 'wipeOnChainBook', calldata });
      });

      // Add a listener for dumpFillViaMarketAid
      bot.eventEmitter.on('dumpFillViaMarketAid', (calldata: string) => {
        this.emit('addToBatch', { botId: botIndex, action: 'dumpFillViaMarketAid', calldata });
      });
    });

    // Start polling to periodically process the batch queue
    this.startPolling();
  }

  // Logical loop for executing the batch when it exists
  private startPolling(): void {
    // Set an arbitrary polling interval in milliseconds (e.g., 5000 ms or 5 seconds)
    // TODO: move to config
    const pollingInterval = 2000;

    setInterval(() => {
      if (!this.batchInProgress && this.batch.length > 0) {
        this.executeBatch();
      }
    }, pollingInterval);
  }


  // Event handler for 'addToBatch'
  private handleAddToBatch(data: any): void {
    // Add the data to the batch and trigger the execution if necessary
    console.log("Adding to batch...", data);

    this.addToBatch(data);
    // if (!this.batchInProgress) {
    //   this.executeBatch();
    // }
  }

  private addToBatch(data: any): void {
    // Find the batch item for the botId
    const botBatchItem = this.batch.find(item => item.botId === data.botId);

    if (botBatchItem) {
      // Update the action with the new calldata
      botBatchItem.actions[data.action] = data.calldata;
    }
  }


  private async executeBatch(): Promise<void> {

    console.log("\nAttempting to execute the batch...");
    console.log("this is my batch!", this.batch);

    const targets: Call[] = [];

    this.batch.forEach((botBatchItem) => {
      for (const actionType in botBatchItem.actions) {
        console.log("\nactionType", actionType, "this bot ID", botBatchItem.botId, "this bot's actions", botBatchItem.actions);
        
        const calldata = botBatchItem.actions[actionType];
        targets.push({
          target: this.marketAid.address,
          function: actionType,
          args: calldata,
        });
      }
    });

    const payload = targets.map(item => item.args);
    console.log("targets", payload);


    try {
      if (this.batchInProgress) {
        console.log("\nBatch already in progress, not shipping batch.");
        return;
      }

      if (payload.length === 0) {
        console.log("\nNo actions in batch, not shipping batch.");
        return;
      }
      const gasEstimate = await this.marketAid.connect(this.config.connections.signer).estimateGas.batchBox(payload);



      if (gasEstimate) {
        console.log("\nShipping batch with gas estimate:", gasEstimate);
        this.batchInProgress = true;

        const tx = await this.marketAid.connect(this.config.connections.signer).batchBox(payload, { gasLimit: gasEstimate });
        this.batchInProgress = true;

        const receipt = await tx.wait();
        this.batchInProgress = false;

        // Clear the batch
        // this.batch = [];
        this.batch = new Array(this.bots.length).fill(null).map((_, botId) => ({ botId, actions: {} }));


        if (receipt.status) {
          console.log("\n🎉 THE BATCH WAS SUCCESSFUL 🎉");
        } else {
          console.log("\n😢 THE BATCH FAILED 😢", receipt);

        }

        // Handle gas spent on transactions and other related logic
        // ...
      } else {
        console.log("\nNo gas estimate returned, not shipping batch.");

      }
    } catch (error) {
      console.error("Error executing batch transaction:", error.message);
      this.batchInProgress = false;
      // this.batch = [];
      this.batch = new Array(this.bots.length).fill(null).map((_, botId) => ({ botId, actions: {} }));

    }
  }


}

export default BatchStrategyExecutor;


export type Call = {
  target: string;
  function: string;
  args: string[] | any[];
};