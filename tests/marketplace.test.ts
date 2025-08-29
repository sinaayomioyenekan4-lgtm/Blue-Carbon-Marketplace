import { describe, expect, it, beforeEach } from 'vitest';

// Interfaces for type safety
interface ClarityResponse<T> {
  ok: boolean;
  value: T | number; // number for error codes
}

interface Order {
  seller: string;
  amount: number;
  pricePerUnit: number;
  remainingAmount: number;
  active: boolean;
  createdAt: number;
  tokenContract: string;
}

interface OrderHistory {
  buyer: string;
  filledAmount: number;
  fillPrice: number;
  timestamp: number;
}

interface EscrowBalance {
  escrowedAmount: number;
}

interface ContractState {
  paused: boolean;
  admin: string;
  nextOrderId: number;
  totalFeesCollected: number;
  orders: Map<number, Order>;
  orderHistory: Map<string, OrderHistory>;
  userOrders: Map<string, number[]>;
  escrowBalances: Map<number, EscrowBalance>;
  stxBalances: Map<string, number>;
  ftBalances: Map<string, Map<string, number>>;
}

// Mock contract implementation
class MarketplaceMock {
  private state: ContractState = {
    paused: false,
    admin: 'deployer',
    nextOrderId: 1,
    totalFeesCollected: 0,
    orders: new Map(),
    orderHistory: new Map(),
    userOrders: new Map(),
    escrowBalances: new Map(),
    stxBalances: new Map(),
    ftBalances: new Map(),
  };

  private ERR_UNAUTHORIZED = 100;
  private ERR_INVALID_AMOUNT = 101;
  private ERR_INVALID_PRICE = 102;
  private ERR_ORDER_NOT_FOUND = 103;
  private ERR_ORDER_NOT_ACTIVE = 104;
  private ERR_INSUFFICIENT_FUNDS = 105;
  private ERR_TRANSFER_FAILED = 106;
  private ERR_PAUSED = 107;
  private ERR_INVALID_RECIPIENT = 108;
  private ERR_ALREADY_EXISTS = 109;
  private ERR_INVALID_ORDER_ID = 110;
  private ERR_FEE_TOO_HIGH = 111;
  private ERR_NOT_OWNER = 112;
  private FEE_PERCENT = 1;
  private COMMUNITY_FUND = 'SP000000000000000000002Q6VF78';
  private MAX_ORDERS_PER_USER = 100;

  // Mock STX and FT transfer functions
  private transferStx(amount: number, sender: string, recipient: string): ClarityResponse<boolean> {
    const senderBalance = this.state.stxBalances.get(sender) ?? 0;
    if (senderBalance < amount) {
      return { ok: false, value: this.ERR_INSUFFICIENT_FUNDS };
    }
    this.state.stxBalances.set(sender, senderBalance - amount);
    this.state.stxBalances.set(recipient, (this.state.stxBalances.get(recipient) ?? 0) + amount);
    return { ok: true, value: true };
  }

  private transferFt(tokenContract: string, amount: number, sender: string, recipient: string): ClarityResponse<boolean> {
    const senderBalances = this.state.ftBalances.get(sender) ?? new Map();
    const senderBalance = senderBalances.get(tokenContract) ?? 0;
    if (senderBalance < amount) {
      return { ok: false, value: this.ERR_INSUFFICIENT_FUNDS };
    }
    senderBalances.set(tokenContract, senderBalance - amount);
    this.state.ftBalances.set(sender, senderBalances);
    const recipientBalances = this.state.ftBalances.get(recipient) ?? new Map();
    recipientBalances.set(tokenContract, (recipientBalances.get(tokenContract) ?? 0) + amount);
    this.state.ftBalances.set(recipient, recipientBalances);
    return { ok: true, value: true };
  }

  private calculateFee(total: number): number {
    return Math.floor((total * this.FEE_PERCENT) / 100);
  }

  // Admin functions
  setAdmin(caller: string, newAdmin: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.admin = newAdmin;
    return { ok: true, value: true };
  }

  pauseContract(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.paused = true;
    return { ok: true, value: true };
  }

  unpauseContract(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.paused = false;
    return { ok: true, value: true };
  }

  withdrawFees(caller: string, amount: number, recipient: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    if (amount > this.state.totalFeesCollected) {
      return { ok: false, value: this.ERR_INSUFFICIENT_FUNDS };
    }
    const result = this.transferStx(amount, 'contract', recipient);
    if (!result.ok) {
      return result;
    }
    this.state.totalFeesCollected -= amount;
    return { ok: true, value: true };
  }

  // Order management
  createSellOrder(caller: string, amount: number, pricePerUnit: number, tokenContract: string): ClarityResponse<number> {
    if (this.state.paused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    if (amount <= 0) {
      return { ok: false, value: this.ERR_INVALID_AMOUNT };
    }
    if (pricePerUnit <= 0) {
      return { ok: false, value: this.ERR_INVALID_PRICE };
    }
    const orderId = this.state.nextOrderId;
    const userOrders = this.state.userOrders.get(caller) ?? [];
    if (userOrders.length >= this.MAX_ORDERS_PER_USER) {
      return { ok: false, value: 113 }; // ERR_TOO_MANY_ORDERS
    }
    const transferResult = this.transferFt(tokenContract, amount, caller, 'contract');
    if (!transferResult.ok) {
      return transferResult;
    }
    this.state.escrowBalances.set(orderId, { escrowedAmount: amount });
    this.state.orders.set(orderId, {
      seller: caller,
      amount,
      pricePerUnit,
      remainingAmount: amount,
      active: true,
      createdAt: Date.now(),
      tokenContract,
    });
    this.state.userOrders.set(caller, [...userOrders, orderId]);
    this.state.nextOrderId += 1;
    return { ok: true, value: orderId };
  }

  cancelOrder(caller: string, orderId: number): ClarityResponse<boolean> {
    if (this.state.paused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    const order = this.state.orders.get(orderId);
    if (!order) {
      return { ok: false, value: this.ERR_ORDER_NOT_FOUND };
    }
    if (order.seller !== caller) {
      return { ok: false, value: this.ERR_NOT_OWNER };
    }
    if (!order.active) {
      return { ok: false, value: this.ERR_ORDER_NOT_ACTIVE };
    }
    const escrow = this.state.escrowBalances.get(orderId);
    if (!escrow) {
      return { ok: false, value: this.ERR_ORDER_NOT_FOUND };
    }
    const transferResult = this.transferFt(order.tokenContract, escrow.escrowedAmount, 'contract', order.seller);
    if (!transferResult.ok) {
      return transferResult;
    }
    this.state.orders.set(orderId, { ...order, active: false, remainingAmount: 0 });
    this.state.escrowBalances.delete(orderId);
    return { ok: true, value: true };
  }

  fillOrder(caller: string, orderId: number, fillAmount: number): ClarityResponse<boolean> {
    if (this.state.paused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    const order = this.state.orders.get(orderId);
    if (!order) {
      return { ok: false, value: this.ERR_ORDER_NOT_FOUND };
    }
    if (!order.active) {
      return { ok: false, value: this.ERR_ORDER_NOT_ACTIVE };
    }
    if (fillAmount <= 0 || fillAmount > order.remainingAmount) {
      return { ok: false, value: this.ERR_INVALID_AMOUNT };
    }
    const totalCost = fillAmount * order.pricePerUnit;
    const fee = this.calculateFee(totalCost);
    const netToSeller = totalCost - fee;
    const stxTransferResult = this.transferStx(totalCost, caller, 'contract');
    if (!stxTransferResult.ok) {
      return stxTransferResult;
    }
    const sellerTransferResult = this.transferStx(netToSeller, 'contract', order.seller);
    if (!sellerTransferResult.ok) {
      return sellerTransferResult;
    }
    const communityTransferResult = this.transferStx(fee, 'contract', this.COMMUNITY_FUND);
    if (!communityTransferResult.ok) {
      return communityTransferResult;
    }
    const ftTransferResult = this.transferFt(order.tokenContract, fillAmount, 'contract', caller);
    if (!ftTransferResult.ok) {
      return ftTransferResult;
    }
    const newRemaining = order.remainingAmount - fillAmount;
    this.state.orders.set(orderId, {
      ...order,
      remainingAmount: newRemaining,
      active: newRemaining > 0,
    });
    if (newRemaining === 0) {
      this.state.escrowBalances.delete(orderId);
    } else {
      this.state.escrowBalances.set(orderId, { escrowedAmount: newRemaining });
    }
    this.state.totalFeesCollected += fee;
    const fillId = (this.state.orderHistory.get(`${orderId}`)?.filledAmount ?? 0) + 1;
    this.state.orderHistory.set(`${orderId}-${fillId}`, {
      buyer: caller,
      filledAmount: fillAmount,
      fillPrice: order.pricePerUnit,
      timestamp: Date.now(),
    });
    return { ok: true, value: true };
  }

  // Read-only functions
  getOrderDetails(orderId: number): ClarityResponse<Order | null> {
    return { ok: true, value: this.state.orders.get(orderId) ?? null };
  }

  getUserOrders(user: string): ClarityResponse<number[] | null> {
    return { ok: true, value: this.state.userOrders.get(user) ?? null };
  }

  getOrderHistory(orderId: number, fillId: number): ClarityResponse<OrderHistory | null> {
    return { ok: true, value: this.state.orderHistory.get(`${orderId}-${fillId}`) ?? null };
  }

  isPaused(): ClarityResponse<boolean> {
    return { ok: true, value: this.state.paused };
  }

  getTotalFees(): ClarityResponse<number> {
    return { ok: true, value: this.state.totalFeesCollected };
  }

  getNextOrderId(): ClarityResponse<number> {
    return { ok: true, value: this.state.nextOrderId };
  }
}

// Test setup
const accounts = {
  deployer: 'deployer',
  seller: 'wallet_1',
  buyer: 'wallet_2',
  user: 'wallet_3',
  tokenContract: 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.carbon-credit-token',
};

describe('Marketplace Contract', () => {
  let contract: MarketplaceMock;

  beforeEach(() => {
    contract = new MarketplaceMock();
    // Initialize balances for testing
    contract['state'].stxBalances.set(accounts.buyer, 1000000);
    const sellerFtBalances = new Map([[accounts.tokenContract, 1000]]);
    contract['state'].ftBalances.set(accounts.seller, sellerFtBalances);
    const contractFtBalances = new Map([[accounts.tokenContract, 0]]);
    contract['state'].ftBalances.set('contract', contractFtBalances);
  });

  it('should initialize with correct state', () => {
    expect(contract.isPaused()).toEqual({ ok: true, value: false });
    expect(contract.getTotalFees()).toEqual({ ok: true, value: 0 });
    expect(contract.getNextOrderId()).toEqual({ ok: true, value: 1 });
  });

  it('should allow admin to set new admin', () => {
    const result = contract.setAdmin(accounts.deployer, accounts.user);
    expect(result).toEqual({ ok: true, value: true });
    expect(contract['state'].admin).toBe(accounts.user);
  });

  it('should prevent non-admin from setting admin', () => {
    const result = contract.setAdmin(accounts.user, accounts.buyer);
    expect(result).toEqual({ ok: false, value: 100 });
  });

  it('should allow admin to pause and unpause contract', () => {
    let result = contract.pauseContract(accounts.deployer);
    expect(result).toEqual({ ok: true, value: true });
    expect(contract.isPaused()).toEqual({ ok: true, value: true });
    result = contract.unpauseContract(accounts.deployer);
    expect(result).toEqual({ ok: true, value: true });
    expect(contract.isPaused()).toEqual({ ok: true, value: false });
  });

  it('should prevent non-admin from pausing contract', () => {
    const result = contract.pauseContract(accounts.user);
    expect(result).toEqual({ ok: false, value: 100 });
  });

  it('should allow seller to create sell order', () => {
    const result = contract.createSellOrder(accounts.seller, 100, 1000, accounts.tokenContract);
    expect(result).toEqual({ ok: true, value: 1 });
    const order = contract.getOrderDetails(1);
    expect(order).toEqual({
      ok: true,
      value: expect.objectContaining({
        seller: accounts.seller,
        amount: 100,
        pricePerUnit: 1000,
        remainingAmount: 100,
        active: true,
        tokenContract: accounts.tokenContract,
      }),
    });
    expect(contract.getUserOrders(accounts.seller)).toEqual({ ok: true, value: [1] });
    expect(contract['state'].escrowBalances.get(1)).toEqual({ escrowedAmount: 100 });
    expect(contract['state'].ftBalances.get('contract')?.get(accounts.tokenContract)).toBe(100);
  });

  it('should prevent creating order when paused', () => {
    contract.pauseContract(accounts.deployer);
    const result = contract.createSellOrder(accounts.seller, 100, 1000, accounts.tokenContract);
    expect(result).toEqual({ ok: false, value: 107 });
  });

  it('should prevent creating order with invalid amount or price', () => {
    let result = contract.createSellOrder(accounts.seller, 0, 1000, accounts.tokenContract);
    expect(result).toEqual({ ok: false, value: 101 });
    result = contract.createSellOrder(accounts.seller, 100, 0, accounts.tokenContract);
    expect(result).toEqual({ ok: false, value: 102 });
  });

  it('should allow seller to cancel order', () => {
    contract.createSellOrder(accounts.seller, 100, 1000, accounts.tokenContract);
    const result = contract.cancelOrder(accounts.seller, 1);
    expect(result).toEqual({ ok: true, value: true });
    const order = contract.getOrderDetails(1);
    expect(order).toEqual({
      ok: true,
      value: expect.objectContaining({
        remainingAmount: 0,
        active: false,
      }),
    });
    expect(contract['state'].escrowBalances.get(1)).toBeUndefined();
    expect(contract['state'].ftBalances.get(accounts.seller)?.get(accounts.tokenContract)).toBe(1000);
  });

  it('should prevent non-seller from cancelling order', () => {
    contract.createSellOrder(accounts.seller, 100, 1000, accounts.tokenContract);
    const result = contract.cancelOrder(accounts.buyer, 1);
    expect(result).toEqual({ ok: false, value: 112 });
  });

  it('should allow buyer to fill order', () => {
    contract.createSellOrder(accounts.seller, 100, 1000, accounts.tokenContract);
    const result = contract.fillOrder(accounts.buyer, 1, 50);
    expect(result).toEqual({ ok: true, value: true });
    const order = contract.getOrderDetails(1);
    expect(order).toEqual({
      ok: true,
      value: expect.objectContaining({
        remainingAmount: 50,
        active: true,
      }),
    });
    expect(contract['state'].stxBalances.get(accounts.buyer)).toBe(1000000 - 50000);
    expect(contract['state'].stxBalances.get(accounts.seller)).toBe(49500); // 50 * 1000 * 0.99
    expect(contract['state'].stxBalances.get(contract.COMMUNITY_FUND)).toBe(500); // 1% fee
    expect(contract['state'].ftBalances.get(accounts.buyer)?.get(accounts.tokenContract)).toBe(50);
    expect(contract['state'].escrowBalances.get(1)).toEqual({ escrowedAmount: 50 });
    expect(contract.getTotalFees()).toEqual({ ok: true, value: 500 });
    const history = contract.getOrderHistory(1, 1);
    expect(history).toEqual({
      ok: true,
      value: expect.objectContaining({
        buyer: accounts.buyer,
        filledAmount: 50,
        fillPrice: 1000,
      }),
    });
  });

  it('should handle full order fill and deactivate', () => {
    contract.createSellOrder(accounts.seller, 100, 1000, accounts.tokenContract);
    const result = contract.fillOrder(accounts.buyer, 1, 100);
    expect(result).toEqual({ ok: true, value: true });
    const order = contract.getOrderDetails(1);
    expect(order).toEqual({
      ok: true,
      value: expect.objectContaining({
        remainingAmount: 0,
        active: false,
      }),
    });
    expect(contract['state'].escrowBalances.get(1)).toBeUndefined();
  });

  it('should prevent filling with invalid amount', () => {
    contract.createSellOrder(accounts.seller, 100, 1000, accounts.tokenContract);
    let result = contract.fillOrder(accounts.buyer, 1, 0);
    expect(result).toEqual({ ok: false, value: 101 });
    result = contract.fillOrder(accounts.buyer, 1, 101);
    expect(result).toEqual({ ok: false, value: 101 });
  });

  it('should prevent filling non-existent or inactive order', () => {
    let result = contract.fillOrder(accounts.buyer, 999, 50);
    expect(result).toEqual({ ok: false, value: 103 });
    contract.createSellOrder(accounts.seller, 100, 1000, accounts.tokenContract);
    contract.cancelOrder(accounts.seller, 1);
    result = contract.fillOrder(accounts.buyer, 1, 50);
    expect(result).toEqual({ ok: false, value: 104 });
  });

  it('should prevent non-admin from withdrawing fees', () => {
    contract.createSellOrder(accounts.seller, 100, 1000, accounts.tokenContract);
    contract.fillOrder(accounts.buyer, 1, 50);
    const result = contract.withdrawFees(accounts.user, 500, accounts.user);
    expect(result).toEqual({ ok: false, value: 100 });
  });
});