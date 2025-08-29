;; Marketplace.clar: Decentralized marketplace for blue carbon credits

;; Constants
(define-constant CONTRACT_OWNER tx-sender)
(define-constant ERR_UNAUTHORIZED u100)
(define-constant ERR_INVALID_AMOUNT u101)
(define-constant ERR_INVALID_PRICE u102)
(define-constant ERR_ORDER_NOT_FOUND u103)
(define-constant ERR_ORDER_NOT_ACTIVE u104)
(define-constant ERR_INSUFFICIENT_FUNDS u105)
(define-constant ERR_TRANSFER_FAILED u106)
(define-constant ERR_PAUSED u107)
(define-constant ERR_INVALID_RECIPIENT u108)
(define-constant ERR_ALREADY_EXISTS u109)
(define-constant ERR_INVALID_ORDER_ID u110)
(define-constant ERR_FEE_TOO_HIGH u111)
(define-constant ERR_NOT_OWNER u112)
(define-constant ERR_TOO_MANY_ORDERS u113)
(define-constant FEE_PERCENT u1) ;; 1% fee
(define-constant MAX_ORDERS_PER_USER u100)
(define-constant COMMUNITY_FUND 'SP000000000000000000002Q6VF78) ;; Mock principal for community fund

;; Data Variables
(define-data-var contract-paused bool false)
(define-data-var admin principal CONTRACT_OWNER)
(define-data-var next-order-id uint u1)
(define-data-var total-fees-collected uint u0)

;; Data Maps
(define-map orders
  { order-id: uint }
  {
    seller: principal,
    amount: uint,
    price-per-unit: uint, ;; in STX microstacks
    remaining-amount: uint,
    active: bool,
    created-at: uint,
    token-contract: principal ;; SIP-10 token contract principal
  }
)

(define-map order-history
  { order-id: uint, fill-id: uint }
  {
    buyer: principal,
    filled-amount: uint,
    fill-price: uint,
    timestamp: uint
  }
)

(define-map user-orders
  { user: principal }
  { orders: (list 100 uint) }
)

(define-map escrow-balances
  { order-id: uint }
  { escrowed-amount: uint }
)

;; Private Functions
(define-private (transfer-stx (amount uint) (sender principal) (recipient principal))
  (stx-transfer? amount sender recipient)
)

(define-private (transfer-ft (token-contract principal) (amount uint) (sender principal) (recipient principal))
  (contract-call? token-contract transfer amount sender recipient none)
)

(define-private (calculate-fee (total uint))
  (/ (* total FEE_PERCENT) u100)
)

(define-private (append-order-to-user (user principal) (order-id uint))
  (let ((current-orders (default-to (list) (get orders (map-get? user-orders {user: user})))))
    (if (>= (len current-orders) MAX_ORDERS_PER_USER)
      (err ERR_TOO_MANY_ORDERS)
      (ok (map-set user-orders {user: user} {orders: (unwrap-panic (as-max-len? (append current-orders order-id) u100))})))
  )
)

;; Public Functions

;; Admin functions
(define-public (set-admin (new-admin principal))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) (err ERR_UNAUTHORIZED))
    (ok (var-set admin new-admin))
  )
)

(define-public (pause-contract)
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) (err ERR_UNAUTHORIZED))
    (ok (var-set contract-paused true))
  )
)

(define-public (unpause-contract)
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) (err ERR_UNAUTHORIZED))
    (ok (var-set contract-paused false))
  )
)

(define-public (withdraw-fees (amount uint) (recipient principal))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) (err ERR_UNAUTHORIZED))
    (asserts! (<= amount (var-get total-fees-collected)) (err ERR_INSUFFICIENT_FUNDS))
    (try! (as-contract (transfer-stx amount tx-sender recipient)))
    (var-set total-fees-collected (- (var-get total-fees-collected) amount))
    (ok true)
  )
)

;; Order management
(define-public (create-sell-order (amount uint) (price-per-unit uint) (token-contract principal))
  (let
    (
      (order-id (var-get next-order-id))
      (seller tx-sender)
    )
    (asserts! (not (var-get contract-paused)) (err ERR_PAUSED))
    (asserts! (> amount u0) (err ERR_INVALID_AMOUNT))
    (asserts! (> price-per-unit u0) (err ERR_INVALID_PRICE))
    ;; Transfer credits to escrow
    (try! (transfer-ft token-contract amount seller (as-contract tx-sender)))
    (map-set escrow-balances {order-id: order-id} {escrowed-amount: amount})
    (map-set orders
      {order-id: order-id}
      {
        seller: seller,
        amount: amount,
        price-per-unit: price-per-unit,
        remaining-amount: amount,
        active: true,
        created-at: block-height,
        token-contract: token-contract
      }
    )
    (try! (append-order-to-user seller order-id))
    (var-set next-order-id (+ order-id u1))
    (print { event: "order-created", order-id: order-id, seller: seller, amount: amount, price: price-per-unit })
    (ok order-id)
  )
)

(define-public (cancel-order (order-id uint))
  (let
    (
      (order (unwrap! (map-get? orders {order-id: order-id}) (err ERR_ORDER_NOT_FOUND)))
      (escrow (unwrap! (map-get? escrow-balances {order-id: order-id}) (err ERR_ORDER_NOT_FOUND)))
    )
    (asserts! (not (var-get contract-paused)) (err ERR_PAUSED))
    (asserts! (is-eq tx-sender (get seller order)) (err ERR_NOT_OWNER))
    (asserts! (get active order) (err ERR_ORDER_NOT_ACTIVE))
    ;; Return escrowed tokens
    (try! (as-contract (transfer-ft (get token-contract order) (get escrowed-amount escrow) tx-sender (get seller order))))
    (map-set orders {order-id: order-id} (merge order {active: false, remaining-amount: u0}))
    (map-delete escrow-balances {order-id: order-id})
    (print { event: "order-cancelled", order-id: order-id, seller: (get seller order) })
    (ok true)
  )
)

(define-public (fill-order (order-id uint) (fill-amount uint))
  (let
    (
      (order (unwrap! (map-get? orders {order-id: order-id}) (err ERR_ORDER_NOT_FOUND)))
      (escrow (unwrap! (map-get? escrow-balances {order-id: order-id}) (err ERR_ORDER_NOT_FOUND)))
      (buyer tx-sender)
      (total-cost (* fill-amount (get price-per-unit order)))
      (fee (calculate-fee total-cost))
      (net-to-seller (- total-cost fee))
      (remaining (get remaining-amount order))
    )
    (asserts! (not (var-get contract-paused)) (err ERR_PAUSED))
    (asserts! (get active order) (err ERR_ORDER_NOT_ACTIVE))
    (asserts! (> fill-amount u0) (err ERR_INVALID_AMOUNT))
    (asserts! (<= fill-amount remaining) (err ERR_INVALID_AMOUNT))
    ;; Buyer pays STX
    (try! (transfer-stx total-cost buyer (as-contract tx-sender)))
    ;; Send net to seller
    (try! (as-contract (transfer-stx net-to-seller tx-sender (get seller order))))
    ;; Send fee to community fund
    (try! (as-contract (transfer-stx fee tx-sender COMMUNITY_FUND)))
    (var-set total-fees-collected (+ (var-get total-fees-collected) fee))
    ;; Send tokens to buyer
    (try! (as-contract (transfer-ft (get token-contract order) fill-amount tx-sender buyer)))
    (let ((new-remaining (- remaining fill-amount)))
      (map-set orders {order-id: order-id} (merge order {remaining-amount: new-remaining, active: (if (> new-remaining u0) true false)}))
      (if (is-eq new-remaining u0)
        (map-delete escrow-balances {order-id: order-id})
        (map-set escrow-balances {order-id: order-id} {escrowed-amount: new-remaining})
      )
    )
    ;; Record fill history
    (map-set order-history 
      {order-id: order-id, fill-id: (len (default-to (list) (map-get? order-history {order-id: order-id})))} 
      {buyer: buyer, filled-amount: fill-amount, fill-price: (get price-per-unit order), timestamp: block-height}
    )
    (print { event: "order-filled", order-id: order-id, buyer: buyer, amount: fill-amount, total-cost: total-cost })
    (ok true)
  )
)

;; Read-only Functions
(define-read-only (get-order-details (order-id uint))
  (map-get? orders {order-id: order-id})
)

(define-read-only (get-user-orders (user principal))
  (get orders (map-get? user-orders {user: user}))
)

(define-read-only (get-order-history (order-id uint) (fill-id uint))
  (map-get? order-history {order-id: order-id, fill-id: fill-id})
)

(define-read-only (is-paused)
  (var-get contract-paused)
)

(define-read-only (get-total-fees)
  (var-get total-fees-collected)
)

(define-read-only (get-next-order-id)
  (var-get next-order-id)
)