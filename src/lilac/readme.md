# Lilac

Lilac is "luscious infrastructure living as code". It's an opinionated take on regular infrastructure-as-code.

Understanding Lilac involves multiple concepts:
1. Lilac Resources ("stems"??)
2. Lilac Comms ("bees"?? "pollinators"??)
3. IAC Providers ("petals"??)
4. Lilac Registry ("seeds"???)

(A lilac resource is a stem; it resolves into many petals. A single petal is an IAC construct according to some IAC provider. The stem with the petals is a flower, i.e., a single logical service. The entire solution is a garden. The registry allows flowers to be defined, i.e., it's the seeds.)

## 1. Lilac Resources

A Lilac Resource is a logical infrastructural service. Some examples of Lilac Resources are:
1. An api gateway
2. A compute cluster
3. A lambda function
4. A document database
5. A blob storage database
6. A queue

The purpose of an infrastructural service is to provide some sort of systems behaviour. In implementing systems, we often have to think about additional, non-behavioural systems concerns - for example, access controls. A Lilac Resource represents only the distilled systems behaviour - when working with Lilac Resources, the non-behavioural concerns disappear.

## 2. Lilac Comms

A Lilac Comm represents a dependency between some Lilac Resources. For example, a lambda function may query/insert documents into a document database. A Comm could be used to represent the lambda function's link to the document database.

## 3. IAC Entities

Lilac provides an opinion on how to represent systems, but it is unopinionated about how that representation is consumed and physically provisioned in the world. In provisioning a Lilac setup, the setup as a whole is converted into a number of IAC Entities - these IAC Entities are aware of a particular provisioning strategy, e.g. aws cloudformation or terraform. A set of IAC Entities is essentially the output of a Lilac setup; they allow a Lilac representation to become a real, functioning system.

## 4. Lilac Registry

The Lilac Registry exhaustively represents the set of Lilac Resource types available. For example, a particular systems primitive (e.g. Temporal) may not have a corresponding Lilac Resource. In such a case, if Temporal is desired, a new Lilac Resource would have to be written for it, and added to the Registry. The Registry also enables development-time testing - a fully mocked Registry can be substituted to the Lilac setup, and the result will be a true-to-production test environment (e.g. local testing).