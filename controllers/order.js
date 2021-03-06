/* eslint-disable no-console */
const { Order } = require("../models/order");
const { errorHandler } = require("../helpers/dbErrorHandler");
const { controllerHelper } = require("../utils/simpleControllerFactory");
const { convertStringNumber } = require("../utils");
const { getContent } = require("./cart");
const { generatePaymentQrCode } = require("./qrCode");
const { linkPaymentToOrder, performSetOrderAndPayment } = require("./payment");
const { setObjectArray } = require("../utils");

const { ORDER_TIME_LIMIT_CODE } = require("../constants");

const {
  // sendNewOrderEmail,
  // sendNewOrderPaymentEmail,
  sendOrderCanceledEmail,
} = require("../mail/controller");

const { /*create, read, update, remove,*/ byId, list } = controllerHelper(
  Order,
  "order",
  true,
  "id"
);

exports.submitOrder = async (req, res) => {
  const { profile, body, settings } = req;
  const val = await getCartContent(req, res);
  if (!val) return res.status(400).json("une erreur s'est produite");

  const { payment, type = "cart" } = body;
  const cartCmd = val[`${type}`];

  const { shipping, contents = [] } = cartCmd;

  if (!cartCmd._id)
    return res.status(400).json("Aucun panier ou liste à commander trouvé");

  if (!shipping)
    return res.status(400).json("Vous devez choisir une adresse de livraison");

  const address = { ...shipping.address };

  shipping.address = await formatAddress(address);
  const contentsFormated = await formatContents(contents);
  const cartFormated = await formatCart(cartCmd);
  const customerFormated = await formatUser(profile);

  let amountPaid = 0;

  const isMomo = payment.method === "momo";
  if (isMomo) {
    amountPaid = convertStringNumber(payment.amount);
  }

  const totalAmount = convertStringNumber(cartCmd.totalAmount);

  const status = checkStatus(totalAmount, amountPaid);
  const completed =
    status === "processing" ? { completedDate: Date.now() } : {};

  const labelType = type === "cart" ? "achat" : "commande";
  const limitDays =
    (settings.find((item) => item.code === ORDER_TIME_LIMIT_CODE) || {})
      .value || 1;

  const expireAt = new Date(Date.now() + limitDays * 24 * 60 * 60 * 1000);

  const value = {
    user: profile,
    shipping,
    payment: isMomo ? [payment] : [],
    contents: contentsFormated,
    [`${type}`]: cartFormated,
    status,
    customerData: customerFormated,
    amountPaid,
    totalAmount,
    updatedBy: profile,
    createdBy: profile,
    count: cartCmd.count,
    type: labelType,
    expireAt,
    ...completed,
  };

  const order = new Order(value);
  req.order = order;

  saveOrder(
    res,
    order,
    async (newOrder) => {
      req.newOrder = newOrder;
      await performPayment(profile, payment, newOrder);
      res.json(newOrder);
      performCompleteCartCmd(cartCmd);
      // sendNewOrderEmail(order);
    },
    "order created"
  );
};

const performPayment = async (
  profile,
  payment,
  order,
  generateNewCode = true
) => {
  payment.method === "localPayment" &&
    generateNewCode &&
    (await performGeneratePaymntCode(profile, payment, order));

  payment.method === "momo" && (await linkPaymentToOrder(payment, order));
};

const performGeneratePaymntCode = async (profile, payment, order) => {
  if (payment.method === "localPayment") {
    try {
      const qrCode = await generatePaymentQrCode(payment, order, profile);
      const {
        order: newOrder,
        payment: newPayment,
      } = await performSetOrderAndPayment(payment, order, profile, qrCode);

      order = newOrder;
      payment = newPayment;

      await populatelite(order);
    } catch (error) {
      console.log("geration code", { error });
    }
  }
};

const performCompleteCartCmd = async (cartCmd) => {
  await cartCmd.remove();
};

exports.update = (req, res) => {
  console.log({ req, res });
};

const getCartContent = async (req, res) => {
  try {
    const resultat = await getContent(req.profile);
    return resultat;
  } catch (error) {
    console.log({ error });
    res.status(400).json({ error, file: "order_getCartConten" });
  }
};

const checkStatus = (totalAmount, amountPaid) => {
  const status =
    amountPaid > 0 //= totalAmount
      ? {
          id: "processing",
          label: "en traitement",
          rank: 0,
        }
      : {
          id: "pending",
          label: "En attente de paiement",
          rank: 0,
        };
  return status;
};

const formatUser = async (user = {}) => {
  const { lastName, firstName, phone, email, id } = user;
  return { lastName, firstName, phone, email, id };
};

const formatAddress = async (address = {}) => {
  const {
    _id,
    firstName,
    lastName,
    description,
    phone,
    city = {},
    postal,
  } = address;

  const { name, code } = city;
  const newAddress = {
    id: _id,
    firstName,
    lastName,
    description,
    phone,
    city: {
      name,
      code,
    },
    postal,
  };
  return newAddress;
};

const formatCart = async (cart = {}) => {
  const { _id, totalDetail = {} } = cart;
  const { tva, price, sale_price, ht, discount, count } = totalDetail;
  return {
    id: _id,
    tva: convertStringNumber(tva),
    price: convertStringNumber(price),
    sale_price: convertStringNumber(sale_price),
    ht: convertStringNumber(ht),
    discount: convertStringNumber(discount),
    count: convertStringNumber(count),
    total: sale_price,
  };
};

const formatContents = async (contents = []) => {
  const newContents = [];
  for (let i = 0; i < contents.length; i++) {
    const element = contents[i];
    const { list, names, classe, school, total, products } = element;
    const classeFormated = await formatClasseSchool(classe);
    const schoolFormated = await formatClasseSchool(school);
    const productsFormated = await formatProducts(products);

    newContents.push({
      classe: classeFormated,
      school: schoolFormated,
      products: productsFormated,
      list,
      names,
      total,
    });
  }

  return newContents;
};

const formatClasseSchool = async (value = {}) => {
  const newValue = value
    ? { id: value._id, name: value.name, slug: value.slug, code: value.code }
    : undefined;
  return newValue;
};

const formatProducts = async (products = []) => {
  const newProducts = [];
  for (let i = 0; i < products.length; i++) {
    const { quantity, product = {} } = products[i];
    delete product.assets.images;

    newProducts.push({
      id: product._id,
      slug: product.slug,
      name: product.name,
      price: convertStringNumber(product.price),
      sale_price: convertStringNumber(product.sale_price),
      order_price: convertStringNumber(product.order_price),
      isbn: product.isbn,
      tva: convertStringNumber(product.tva),
      discount: convertStringNumber(product.discount),
      assets: product.assets,
      ht: convertStringNumber(product.ht),
      quantity: convertStringNumber(quantity),
    });
  }
  return newProducts;
};

exports.submitInstallmentPayment = async (req, res) => {
  let { order, profile, body } = req;

  let { payment } = body;

  if (!payment) sendError(res, " payment is required");
  if (payment && !payment.amount)
    sendError(res, " payment amount  is required");
  if (payment && !payment.method)
    sendError(res, " payment methode  is required");

  await performGeneratePaymntCode(profile, payment, order);
  order = await inputPaymentToOrder(profile, payment, order);

  saveOrder(
    res,
    order,
    async (newOrder) => {
      await performPayment(profile, payment, newOrder, false);
      await populateFull(order);
      res.json(order);
      // sendNewOrderPaymentEmail(order);
    },
    "order remove failed"
  );
};

const impactQrPaymentToOrder = (profile, payment, order) =>
  new Promise(async (resolve, reject) => {
    let sorder = await inputPaymentToOrder(profile, payment, order);

    sorder.save((err, newOrder) => {
      if (err) {
        console.log("cannot link qrcode payment to order");
        reject(err);
      } else {
        resolve(newOrder);
      }
    });
  });

const inputPaymentToOrder = async (profile, payment, order) => {
  let { amount, method, status = {} } = payment;

  const isMomo = method === "momo";
  const isQrCodePayment =
    method === "localPayment" && status.id === "validated";

  if (isMomo || isQrCodePayment) {
    const newAmount = convertStringNumber(amount);
    const amountPaid = convertStringNumber(order.amountPaid) + newAmount;

    const newStatus = checkStatus(order.totalAmount, amountPaid);
    order.status = newStatus;
    if (newStatus === "processing") order.completedDate = Date.now();
    order.amountPaid = amountPaid;
    order.payment.push(payment);
    order.payment = setObjectArray(order.payment);
  }

  order.updatedBy = profile;
  return order;
};
exports.impactValidQrPaymentToOrder = async (req, res, next) => {
  const { profile, payment, order } = req;

  try {
    const newOrder = await impactQrPaymentToOrder(profile, payment, order);
    req.order = newOrder;
    next();
  } catch (error) {
    res.status(400).json({ error: errorHandler(error) });
  }
};

exports.impactQrPaymentToOrder = impactQrPaymentToOrder;

exports.remove = async (req, res) => {
  const { profile, order } = req;
  order.status = {
    id: "trash",
    label: "Supprimée",
  };

  order.updatedBy = profile._id;

  saveOrder(
    res,
    order,
    (newOrder) => {
      req.newOrder = newOrder;
      res.json({ suucess: "Suppression effectuée avec succès", newOrder });
    },
    "order remove failed"
  );
};

exports.cancel = async (req, res) => {
  const { profile, order } = req;
  if (order.status.id !== "pending") {
    return res
      .status(400)
      .json({ error: "Vous ne pouvez plus annuler cette commande" });
  }

  order.status = {
    id: "cancelled",
    label: "Annulée",
  };

  order.updatedBy = profile._id;
  orderSaver(res, order, "order canceled failed", sendOrderCanceledEmail);
};

const orderSaver = async (
  res,
  order
  // errorIndicator,
  // mailSender = async () => {}
) => {
  saveOrder(
    res,
    order,
    async (newOrder) => {
      await populatelite(newOrder);
      res.json(newOrder);
      // await mailSender(order);
    },
    "order submit installment payment"
  );
};

exports.listByStatus = (req, res) => {
  const query = {};
  if (req.query.status) {
    query.status = req.query.status;
  }

  Order.find(query, (err, orders) => {
    if (err) {
      return res.status(400).json({
        error: errorHandler(err),
      });
    }
    res.json({ orders });
  });
};

/**
 * Step seraching
 */

exports.listSearch = async (req, res) => {
  performSearching(req, res, "full", (data) =>
    res.json({
      ...data,
    })
  );
};

exports.pricesRangesBySearch = async (req, res) => {
  performSearching(req, res, "pricesRange", (data) => {
    const range = findMinMax(data.results);
    res.json({
      min: range[0],
      max: range[1],
      range,
    });
  });
};

exports.listPartialSearch = async (req, res) => {
  performSearching(req, res, "partial", (data) =>
    res.json({
      ...data,
    })
  );
};

const performSearching = (req, res, type = "full", next) => {
  const { query } = req;
  let {
    order = "desc",
    sortBy = "createdAt",
    limit,
    offset,
    search,
    price,
    dates,
    status,
    localstatus,
    searchInFields = [],
    ...restQuery
  } = query;

  const isNormalSearching = ["pricesRange"].indexOf(type) === -1;
  limit = isNormalSearching ? limit && parseInt(query.limit) : undefined;

  let textFilter = search ? { $text: { $search: search } } : {};

  if (type === "partial") {
    textFilter = search
      ? {
          $or: searchInFields.map((field) => {
            return {
              [`${field}`]: {
                $regex: search,
                $options: "-i",
              },
            };
          }),
        }
      : "";
  }

  const statusFilter = status ? { "status.id": status } : {};
  const localStatusFilter = localstatus
    ? { "localStatus.id": localstatus }
    : {};

  const datesFilter = dates
    ? {
        "createdAt": {
          $gte: new Date(dates[0]),
          $lte: new Date(dates[1]),
        },
      }
    : {};

  const pricesFilter = isNormalSearching
    ? price
      ? {
          $or: [
            {
              "totalAmount": {
                $gte: parseInt(price[0]),
                $lte: parseInt(price[1]),
              },
            },
          ],
        }
      : {}
    : {};

  let filter = {
    ...textFilter,
    ...pricesFilter,
    ...statusFilter,
    ...localStatusFilter,
    ...datesFilter,
    ...restQuery,
  };

  execSearchPaginate(
    res,
    filter,
    {
      sortBy,
      order,
      limit,
      offset,
      searchInFields,
      select:
        type === "pricesRange"
          ? "totalAmount"
          : " id status createdAt updatedAt totalAmount customerData shipping.firstName" +
            " shipping.lastName payment count amountPaid localStatus",
      toSort: type !== "pricesRange",
    },
    (data) => next(data)
  );
};

const findMinMax = (arr) => {
  if (arr.length === 0) return [0, 0];
  let min = arr[0].totalAmount,
    max = arr[0].totalAmount;
  for (let i = 1, len = arr.length; i < len; i++) {
    let v = arr[i].totalAmount;
    min = v < min ? v : min;
    max = v > max ? v : max;
  }

  return [min, max];
};

const execSearchPaginate = (
  res,
  filter,
  {
    sortBy,
    order,
    limit,
    offset,
    searchInFields,
    select = searchInFields.join(" "),
    toSort = true,
  },
  next
) => {
  const myCustomLabels = {
    totalDocs: "count",
    docs: "results",
  };

  const option = {
    select: select,
    // projection: toSort ? { score: { $meta: "textScore" } } : {},
    sort: toSort
      ? { /*score: { $meta: "textScore" },*/ [`${sortBy}`]: order }
      : {},
    pagination: limit !== undefined,
    customLabels: myCustomLabels,
    // populate: {
    //   path: "customer",
    //   select: "name email first_name last_name username",
    // },
  };

  if (limit) option.limit = limit;
  if (offset) option.offset = offset;

  Order.paginate(filter, option, (err, data) => {
    if (err) {
      console.log({ err });
      return res.status(400).json({
        error: err,
      });
    }
    const {
      results,
      count,
      hasNextPage,
      hasPrevPage,
      prevPage,
      nextPage,
    } = data;

    const m = {
      count: count,
      next: hasNextPage && `offset=${data.limit * (nextPage - 1)}`,
      previous: hasPrevPage && `offset=${data.limit * (prevPage - 1)}`,
      results: results,
    };

    next(m);
  });
};

/**
 * Synchronisation
 */

exports.read = async (req, res) => {
  const { order } = req;
  await populateFull(order);
  return res.json(order);
};

exports.getStatusValues = (req, res) => {
  res.json(Order.schema.path("status").options.enum);
};

exports.getLocalStatusValues = (req, res) => {
  res.json(Order.schema.path("localStatus").options.enum);
};

exports.getTypeValues = (req, res) => {
  res.json(Order.schema.path("type").enumValues);
};

exports.updateLocalStatus = (req, res) => {
  performUpdateStatus(req, res, "localStatus", (val) => {
    res.json(val);
  });
};

exports.updateStatus = (req, res) => {
  performUpdateStatus(req, res, "status", (val) => {
    res.json(val);
  });
};

const performUpdateStatus = (req, res, field, next) => {
  const { order, body, profile } = req;
  const myStatus = body[`${field}`];

  if (!myStatus) return res.status(400).json("vous devez spécifier le status");

  const allStatus = Order.schema.path(`${field}`).options.enum;
  const index = allStatus.findIndex((item) => item.id === myStatus.id);
  if (index === -1) return res.status(400).json("Status non valide");

  order[`${field}`] = myStatus;
  order.updatedBy = profile;

  order.save((err, newOrder) => {
    if (err) {
      return res.status(400).json({
        error: errorHandler(err),
        model: "order performStatus",
      });
    } else next(newOrder);
  });
};

const saveOrder = (res, order, next, errorComment) => {
  order.save((err, newOrder) => {
    if (err) {
      console.log({ err });
      return res.status(400).json({
        error: errorHandler(err),
        errorComment,
      });
    }

    next && next(newOrder);
  });
};

exports.listByUser = (req, res) => {
  const { profile, query } = req;
  const { type, status, order: byOrder = "desc" } = query;
  const sense = byOrder === "desc" ? -1 : 1;

  let filter = { type, "status.id": status ? status : undefined };
  filter = JSON.parse(JSON.stringify(filter));

  Order.find({ user: profile, ...filter })
    .select(
      "id status totalAmount leftToPay amountPaid leftToPay type createdAt count"
    )
    .sort({ createdAt: sense })
    .exec((err, orders) => {
      if (err) {
        return res.status(400).json({
          error: errorHandler(err),
        });
      }
      res.json(orders);
    });
};

exports.listInstallPaymentByUser = async (req, res) => {
  let { payment, totalAmount, leftToPay, amoundPaid } = req.order;
  await payment.sort(function(a, b) {
    return new Date(b.date_paid) - new Date(a.date_paid);
  });
  res.json({ payment, totalAmount, leftToPay, amoundPaid });
};

const populateFull = async (order) => {
  order.populate([
    {
      path: "user",
      select:
        "name email lastName firstName email nomAfficher phone imageUrl id",
    },
    {
      path: "payment",
      select: fullPaymentPolpulatePath,
      populate: {
        path: "qrCode",
        select: "code dateExpire amount",
      },
    },
  ]);

  await order.execPopulate();
  return order;
};

const populatelite = async (order) => {
  order.populate([
    {
      path: "user",
      select: "name email lastName firstName email nomAfficher phone",
    },
    {
      path: "payment",
      select: litePaymentPolpulatePath,
      populate: {
        path: "qrCode",
        select: "code dateExpire amount",
      },
    },
  ]);

  await order.execPopulate();
  return order;
};

const litePaymentPolpulatePath =
  " phone method status qrCode payerData amount method_title transaction_id";
const fullPaymentPolpulatePath =
  " phone method status order qrCode payerData amount method_title transaction_id transaction updatedBy";

exports.orderById = byId;
exports.formatUser = formatUser;

exports.list = list;

const sendError = (res, message) => {
  return res.status(400).json({
    error: message,
  });
};
