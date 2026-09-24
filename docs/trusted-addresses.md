# Trusted addresses

Flizy only allows transfers to destinations you already trust.

Trusted destinations are added on the Flizy site, under Account, and your
account password is required at the moment you add one. A linked chat app cannot
add a destination. Ask it to, and it replies with a link that finishes the job on
the site, carrying the address across so you do not have to retype it.

That is the point of the split. Sending money once and creating somewhere money
can be sent repeatedly are different acts, and the second one needs the stronger
proof. Someone holding your phone, or your WhatsApp or Telegram account, cannot
create a payout destination.

## New destinations wait 24 hours

A destination you add cannot receive anything for 24 hours. Changing the address
of an existing one starts a fresh 24 hours, because that is the same act as
adding a new destination. Renaming one does not.

A send to a destination that is still waiting is refused, and nothing leaves
your balance. The refusal says how much of the 24 hours is left.

While a destination is waiting, every chat app you have linked is told about it,
with its name and how to stop it. If it was not you, reply in any linked chat:

```
cancel wallet
```

That cancels everything still waiting. Name one to cancel only that:

```
cancel wallet john
```

Cancelling is allowed from chat because it takes authority away rather than
granting it, and because the warning arrives in chat, so the answer to it has to
work there too.

Removing a destination you already use is different, and is done on the site with
your password. If you need to stop all spending immediately, send `flizy lock` in
any linked chat. That is instant and needs no password.

If a send is rejected because the destination is not on your list, open the site,
add it, and send again once its 24 hours are up.
