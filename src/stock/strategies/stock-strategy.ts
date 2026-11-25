export interface StockStrategy {
  readonly name: string;
  // 기존 전략은 Stock 행 전체를 돌려준다. redis-lua는 DB 행이 없으므로 응답에 필요한 필드만 보장한다
  decrease(
    id: number,
    quantity: number,
  ): Promise<{ id: number; quantity: number }>;
  // 재고를 DB 밖에 따로 두는 전략용 훅. 없으면 DB만 쓴다
  reset?(id: number, quantity: number): Promise<void>;
  liveQuantity?(id: number): Promise<number | null>;
}

export const STOCK_STRATEGY = Symbol('STOCK_STRATEGY');
