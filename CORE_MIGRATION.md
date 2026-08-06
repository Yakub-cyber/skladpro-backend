# Переход на учётное ядро — что меняется в коде

Миграции `0013`–`0015` уже дают правильное ядро. Этот документ — техзадание
на переписывание роутов. Скармливать Claude Code по одному разделу за раз,
не всё сразу.

**Главное правило после этой миграции:**
никакой прикладной код не пишет `stock`, `cost`, `batches`, `balance`,
`stock_movements`, `settlement_movements`, `money_movements` и
`stock_balances`. Роут вставляет `docs` + `doc_lines` и вызывает
`post_doc()`. Всё.

---

## Порядок работ

1. Применить миграции (`npm run migrate`) — фронт продолжает работать, зеркала на месте.
2. Переписать 5 роутов (ниже).
3. Прогнать тесты, поправить упавшие.
4. `select install_ledger_guard();` — после этого база физически не даст вернуться к старому поведению.
5. Только потом переключать веб/мобилку/POS на `v_stock_available`.

---

## 1. `src/routes/documents.ts`

Сейчас: 80 строк арифметики с тремя ветками и `consumeFifo`.
Станет: маппинг типа + две вставки + вызов функции.

| Старый `type` | Новый `doc_type` |
|---|---|
| `receive` (есть поставщик) | `purchase_receipt` |
| `receive` (без поставщика) | `stock_income` |
| `writeoff` | `writeoff` |
| `adjust` | `inventory` |

```ts
await client.query(
  `insert into docs (company_id, id, doc_type, warehouse_id, party_kind, party_id, note, reason, "by")
   values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
  [companyId, doc.id, docType, doc.warehouseId, partyKind, partyId, doc.note, doc.reason, actor])

for (const [i, item] of items.entries()) {
  await client.query(
    `insert into doc_lines (company_id, id, doc_id, line_no, product_id, unit_id, unit_factor,
                            qty_input, qty, price)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [companyId, `${doc.id}-${i}`, doc.id, i, item.productId, item.unitId ?? null,
     item.factor ?? 1, item.qty, round4(item.qty * (item.factor ?? 1)), item.cost ?? item.price ?? 0])
}

const { rows } = await client.query('select post_doc($1,$2) as total', [companyId, doc.id])
```

Всё остальное — `consumeFifo`, ручные `update products set stock = …`,
подсчёт `nextCost`, вставка в `movements` — **удаляется**.

Важно: `qty` в `doc_lines` — всегда в БАЗОВОЙ единице. `qty_input` — что ввёл
человек. Пересчёт делает роут при вставке, а не БД, чтобы `unit_factor`
зафиксировался в строке навсегда.

Для `inventory` в `qty` кладётся **новый фактический остаток**, а не дельта.
Дельту посчитает `post_doc`.

---

## 2. `src/routes/sales.ts`

Продажа перестаёт быть «orders со stock_consumed». Заказ остаётся заказом,
а факт отгрузки становится документом.

- `customerId === 'retail'` и не в долг → `doc_type = 'retail_receipt'`,
  указать `account_id` (счёт кассы) — деньги реально попадут в кассу.
- иначе → `doc_type = 'sales_shipment'`, `party_kind='customer'`, `party_id`.
- `order_id` в `docs` = id заказа, чтобы связь заказ↔отгрузка была явной.

Удаляется:
- проверка `p.stock < qty` — её делает `apply_stock` под блокировкой;
- `update products set stock = stock - …`;
- `consumeFifo` и запись `cost` в `enrichedItems`;
- `update customers set balance = … + total`;
- вставка в `movements`.

Остаётся без изменений: `Idempotency-Key`, валидация, пересчёт сумм на
сервере, коды маркировки, `publishEvent` после коммита.

`FOR UPDATE` по товарам больше не нужен в роуте — блокировка теперь на строке
`stock_balances` внутри `apply_stock`, и это правильнее: блокируется остаток
конкретного склада, а не карточка товара целиком.

---

## 3. `src/routes/returns.ts`

Здесь был **реальный баг с потерей денег**:

```sql
update customers set balance = greatest(0, coalesce(balance, 0) - $3)
```

Если у клиента предоплата (баланс отрицательный), возврат обрезался нулём и
предоплата исчезала. Убрать целиком.

Возврат становится документом `sales_return` (`party_kind='customer'`),
`post_doc` сам вернёт товар на склад и уменьшит долг — в том числе в минус,
как и должно быть.

Возврат поставщику → `purchase_return`.

---

## 4. `src/routes/orders.ts`

Отмена заказа с уже проведённой отгрузкой:

```ts
const { rows } = await client.query(
  `select id from docs where company_id=$1 and order_id=$2 and status='posted'
     and doc_type in ('sales_shipment','retail_receipt') for update`, [companyId, orderId])
for (const d of rows) await client.query('select unpost_doc($1,$2)', [companyId, d.id])
```

Функции `applyOrderStock` / `direction = ±1` удаляются. Если товар уже ушёл
дальше и вернуть нельзя — `unpost_doc` честно упадёт с `P0001`, вместо того
чтобы увести остаток в минус.

---

## 5. `src/routes/customers.ts`

`POST /v1/customers/:id/payments` больше не двигает баланс напрямую.
Создаёт документ `payment_in` с `account_id` — и деньги наконец приходят
в кассу, а не растворяются.

`kind: 'adjustment'` → документ `opening_settlement` с нужным знаком в `amount`.

---

## 6. `src/routes/sync.ts`

- В pull-whitelist добавить: `docs`, `doc_lines`, `product_units`,
  `money_accounts`, `stock_balances`, `product_aliases`.
- Реестры (`stock_movements`, `settlement_movements`, `money_movements`)
  клиентам **не отдавать** — они большие и не нужны на устройстве; остатки
  приезжают через `stock_balances`.
- В push-запрет (`SERVER_MANAGED`) добавить все таблицы выше плюс
  `products.stock`, `products.cost`, `products.batches`, `customers.balance`,
  `suppliers.balance`.
- Курьеру `stock_balances` и `doc_lines.price` не отдавать (там себестоимость).

---

## 7. Удалить

- `src/lib/fifo.ts` — себестоимость теперь средневзвешенная по складу,
  считается в `apply_stock`.
- Записи в таблицу `movements` — её заменил `stock_movements`. Саму таблицу
  пока не дропать: там история, перенести отдельным скриптом при желании.

---

## Осознанный размен: FIFO → средневзвешенная

Ты был на FIFO. Ядро использует среднюю себестоимость по складу. Причина:
FIFO поверх реестра требует партии как отдельные строки с остатком, а
распроведение документа из середины истории при FIFO корректно не
откатывается вообще — партии уже съедены следующими продажами. Средняя
откатывается точно. Так работает CloudShop.

В схеме зарезервировано место под партии: если позже понадобится FIFO,
добавляется таблица `stock_batches` и `batch_id` в `stock_movements`,
`post_doc` меняется в одном месте. Роуты трогать не придётся — в этом и был
смысл всей затеи.

## Коды ошибок

| Код | Смысл |
|---|---|
| `P0001` | Недостаточно товара |
| `P0002` | Документ не найден |
| `P0003` | Документ уже проведён |
| `P0004` | Неизвестный тип документа |
| `P0005` | Количество ≤ 0 |
| `P0006` | Не указан контрагент |
| `P0007` | Не указан счёт денег |
| `P0008` | Документ не проведён (при распроведении) |
| `P0009` | Попытка записать зеркало в обход `post_doc` |

Их надо замапить в `src/lib/errors.ts` на человеческие сообщения, как сейчас
сделано с `insufficientStock`.
